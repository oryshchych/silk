/**
 * The PDF upload route with a real Postgres and a fake S3 that VERIFIES the signature: the type is read from
 * the BYTES (an HTML page named `.pdf` is refused and nothing is stored), the size cap holds on a real
 * stream, the object is stored as `application/pdf` with `Content-Disposition: attachment`, the row and the
 * audit entry commit together, a published version takes no file, a role without `legal.edit` is refused
 * before the body is read, and a replaced file's object is removed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { createLegalDraft, legalCreateSchema, publishLegalDocument } from '@store/core/legal';
import { authUsers } from '@store/db/schema';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import { createStorage } from '@store/media/storage';
import {
  FAKE_ACCESS_KEY,
  FAKE_BUCKET,
  FAKE_SECRET_KEY,
  startFakeS3,
  type FakeS3,
} from '@store/media/test/fake-s3';

const USER = '00000000-0000-4000-8000-0000000000dd';
const state: { role: AdminSession['role']; handle: Db | null; fake: FakeS3 | null } = vi.hoisted(
  () => ({ role: 'content', handle: null, fake: null }),
);

vi.mock('@/lib/admin/bound-action', async () => {
  const { createAdminAction } = await import('../src/lib/admin/action');
  const { createRateLimiter } = await import('../src/lib/rate-limit');
  return {
    requestOriginOk: () => Promise.resolve(true),
    adminAction: createAdminAction({
      originOk: () => Promise.resolve(true),
      session: () =>
        Promise.resolve({
          kind: 'full',
          session: { sid: 's', userId: USER, email: 'pdf@example.test', role: state.role },
        } satisfies ResolvedSession),
      transaction: async (fn) => {
        if (state.handle === null) throw new Error('no database');
        return await state.handle.transaction(fn);
      },
      client: () => Promise.resolve('203.0.113.9'),
      limiter: createRateLimiter({ limit: 1_000, windowMs: 60_000 }),
    }),
  };
});
vi.mock('@/lib/admin/session', () => ({
  currentSession: () =>
    Promise.resolve({
      kind: 'full',
      session: { sid: 's', userId: USER, email: 'pdf@example.test', role: state.role },
    } satisfies ResolvedSession),
}));
// The route imports these through the `@/` alias, which this test config does not resolve: point them at the real modules.
vi.mock('@/lib/in-flight', async () => await import('../src/lib/in-flight'));
vi.mock('@/lib/rate-limit', async () => await import('../src/lib/rate-limit'));
vi.mock('@/lib/read-capped', async () => await import('../src/lib/read-capped'));
vi.mock('@/lib/db', () => ({
  getDb: () => {
    if (state.handle === null) throw new Error('no database');
    return Promise.resolve(state.handle);
  },
}));
vi.mock('@/lib/request-limits', () => ({
  checkRequestLimit: () => Promise.resolve({ allowed: true }),
}));
vi.mock('@/lib/media', () => ({
  mediaConfig: () =>
    Promise.resolve(
      state.fake === null
        ? null
        : {
            storage: createStorage({
              endpoint: state.fake.endpoint,
              bucket: FAKE_BUCKET,
              accessKeyId: FAKE_ACCESS_KEY,
              secretAccessKey: FAKE_SECRET_KEY,
            }),
            publicBase: 'https://media.example',
          },
    ),
}));

vi.mock('@/lib/admin/invalidate', () => ({ invalidateTags: () => undefined }));
vi.mock('@/lib/legal-pages', () => ({ knownLegalPages: { invalidate: () => undefined } }));

const { POST } = await import('../src/app/admin/upload/legal-pdf/route');
const actions = await import('../src/actions/admin-legal');

let testDb: TestDatabase;
let handle: DbHandle;
let fake: FakeS3;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  fake = await startFakeS3();
  state.fake = fake;
  await handle.db.insert(authUsers).values({ id: USER, email: 'pdf@example.test' });
});
afterAll(async () => {
  await fake.close();
  await handle.close();
  await testDb.drop();
});
beforeEach(() => {
  state.role = 'content';
  fake.objects.clear();
});

const PDF = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const post = async (id: string, body: Uint8Array | string) =>
  await POST(
    new Request(`http://localhost/admin/upload/legal-pdf?id=${id}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : new Uint8Array(body),
    }),
  );
async function draft(kind: 'terms' | 'privacy' = 'terms'): Promise<string> {
  const created = await handle.db.transaction(
    async (tx) =>
      await createLegalDraft(
        tx,
        USER,
        legalCreateSchema.parse({ kind, locale: 'uk', title: 'T', source: 'x' }),
      ),
  );
  return created.id;
}

describe('POST /admin/upload/legal-pdf', () => {
  it('stores a real PDF as an attachment and records it with an audit row', async () => {
    const id = await draft();
    const response = await post(id, PDF);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const [key, object] = [...fake.objects.entries()][0] ?? [];
    expect(key).toMatch(new RegExp(`^legal/${id}/[0-9a-f-]{36}\\.pdf$`));
    expect(object?.contentType).toBe('application/pdf');
    expect(object?.contentDisposition).toBe('attachment; filename="document.pdf"');
    // A draft is never cached publicly.
    expect(object?.cacheControl).toBe('private, no-store');
    expect(object?.body.equals(PDF)).toBe(true);
    expect(fake.rejected).toBe(0);
    const row = await handle.pool.query(
      `SELECT file_url, file_key, file_size FROM legal_documents WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({
      file_url: `https://media.example/${key ?? ''}`,
      file_key: key,
      file_size: PDF.length,
    });
    const audit = await handle.pool.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'legal.file_set'`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('refuses an HTML page named like a PDF: the bytes decide, nothing is stored', async () => {
    const id = await draft();
    const response = await post(id, '<html><script>alert(1)</script></html>');
    expect(response.status).toBe(415);
    expect(fake.objects.size).toBe(0);
    const stored = await handle.pool.query<{ file_url: string | null }>(
      `SELECT file_url FROM legal_documents WHERE id = $1`,
      [id],
    );
    expect(stored.rows[0]?.file_url).toBeNull();
  });

  it('refuses a body over the cap while it streams (no declared length), and stores nothing', async () => {
    const id = await draft();
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024).fill(0x41);
        chunk.set(PDF.subarray(0, 8));
        for (let i = 0; i < 10; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await POST(
      new Request(`http://localhost/admin/upload/legal-pdf?id=${id}`, {
        method: 'POST',
        body: big,
        duplex: 'half',
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(fake.objects.size).toBe(0);
  });

  it('refuses a role without legal.edit before the body is read', async () => {
    state.role = 'manager';
    const id = await draft();
    expect((await post(id, PDF)).status).toBe(403);
    expect(fake.objects.size).toBe(0);
  });

  it('takes no file for a published version and leaves no object behind', async () => {
    const id = await draft('privacy');
    await handle.db.transaction(async (tx) => await publishLegalDocument(tx, USER, id));
    const response = await post(id, PDF);
    expect(response.status).toBe(409);
    expect(fake.objects.size).toBe(0);
  });

  it('answers 404 for an unknown document and 400 for a malformed id', async () => {
    expect((await post('00000000-0000-4000-8000-00000000dead', PDF)).status).toBe(404);
    expect((await post('not-a-uuid', PDF)).status).toBe(400);
  });

  it('removes the previous object when a draft gets a new file', async () => {
    const id = await draft();
    await post(id, PDF);
    const first = [...fake.objects.keys()][0];
    await post(id, Buffer.concat([PDF, Buffer.from('\n% second')]));
    expect(fake.objects.size).toBe(1);
    expect([...fake.objects.keys()][0]).not.toBe(first);
  });

  it('deletes the draft AND its stored PDF; replacing and removing a PDF remove the object too', async () => {
    const id = await draft();
    await post(id, PDF);
    expect(fake.objects.size).toBe(1);
    state.role = 'owner';
    expect(await actions.deleteLegalDraftAction({ id })).toMatchObject({ ok: true });
    expect(fake.objects.size).toBe(0);
    expect(
      (await handle.pool.query(`SELECT 1 FROM legal_documents WHERE id = $1`, [id])).rowCount,
    ).toBe(0);

    state.role = 'content';
    const other = await draft();
    await post(other, PDF);
    expect(await actions.removeLegalFileAction({ id: other })).toMatchObject({
      ok: true,
      data: { removed: true },
    });
    expect(fake.objects.size).toBe(0);
  });
});
