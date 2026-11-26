/**
 * The real legal action chain against Postgres: action -> `createAdminAction` (Origin, session, role,
 * limit, validation, ONE transaction, audit) -> the domain. The role matrix (content drafts but cannot
 * publish or delete; a manager touches nothing), the audit row of every change (never the text), and the
 * cache tags dropped after a publish only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { authUsers } from '@store/db/schema';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const USER = '00000000-0000-4000-8000-0000000000cc';
const state: { role: AdminSession['role']; handle: Db | null; tags: string[] } = vi.hoisted(() => ({
  role: 'content',
  handle: null,
  tags: [],
}));

async function wired() {
  const { createAdminAction: create } = await import('../src/lib/admin/action');
  const { createRateLimiter: limiter } = await import('../src/lib/rate-limit');
  return {
    adminAction: create({
      originOk: () => Promise.resolve(true),
      session: () =>
        Promise.resolve({
          kind: 'full',
          session: { sid: 's', userId: USER, email: 'legal@example.test', role: state.role },
        } satisfies ResolvedSession),
      transaction: async (fn) => {
        if (state.handle === null) throw new Error('no database');
        return await state.handle.transaction(fn);
      },
      client: () => Promise.resolve('203.0.113.9'),
      limiter: limiter({ limit: 1_000, windowMs: 60_000 }),
    }),
  };
}
vi.mock('@/lib/admin/bound-action', wired);
vi.mock('../src/lib/admin/bound-action', wired);
vi.mock('@/lib/admin/invalidate', () => ({
  invalidateTags: (tags: readonly string[]) => {
    state.tags.push(...tags);
  },
}));
vi.mock('@/lib/media', () => ({ mediaConfig: () => Promise.resolve(null) }));

const actions = await import('../src/actions/admin-legal');

let testDb: TestDatabase;
let handle: DbHandle;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  await handle.db.insert(authUsers).values({ id: USER, email: 'legal@example.test' });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});
beforeEach(() => {
  state.role = 'content';
  state.tags.length = 0;
});

const draftInput = {
  kind: 'terms',
  locale: 'uk',
  title: 'Terms',
  source: '## One\n\nSECRET-LEGAL-TEXT',
};

async function newDraft(): Promise<string> {
  const created = await actions.createLegalDraftAction(draftInput);
  if (!created.ok) throw new Error(`create failed: ${created.code}`);
  return created.data.id;
}
async function auditFor(id: string) {
  const rows = await handle.pool.query(
    `SELECT action, diff, user_id, ip FROM audit_log WHERE entity = 'legal_document' AND entity_id = $1 ORDER BY created_at, id`,
    [id],
  );
  return rows.rows as { action: string; diff: unknown; user_id: string; ip: string }[];
}

describe('role matrix', () => {
  it('content drafts and edits but cannot publish or delete', async () => {
    const id = await newDraft();
    expect(
      await actions.updateLegalDraftAction({ id, title: 'Terms 2', source: 'Changed' }),
    ).toMatchObject({ ok: true });
    expect(await actions.publishLegalAction({ id })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await actions.deleteLegalDraftAction({ id })).toEqual({ ok: false, code: 'FORBIDDEN' });
    const row = await handle.pool.query<{ status: string }>(
      `SELECT status FROM legal_documents WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('draft');
    expect(state.tags).toEqual([]);
  });

  it('a manager (no legal permission) can do nothing, before the input is even parsed', async () => {
    state.role = 'manager';
    expect(await actions.createLegalDraftAction({ nonsense: true })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await actions.publishLegalAction({ id: 'not-a-uuid' })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await actions.removeLegalFileAction({ id: 'x' })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('an admin publishes; the page tags are dropped only then', async () => {
    const id = await newDraft();
    state.role = 'admin';
    const done = await actions.publishLegalAction({ id });
    expect(done).toMatchObject({ ok: true, data: { kind: 'terms', locale: 'uk' } });
    expect(state.tags).toEqual(['legal:terms', 'legal-nav']);
  });

  it('refuses invalid input and an unknown kind', async () => {
    expect(await actions.createLegalDraftAction({ ...draftInput, kind: 'offer' })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await actions.createLegalDraftAction({ ...draftInput, title: '   ' })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });
});

describe('audit', () => {
  it('writes one row per change with the author and the address, never the text', async () => {
    const id = await newDraft();
    await actions.updateLegalDraftAction({ id, title: 'T', source: 'SECRET-LEGAL-TEXT again' });
    state.role = 'owner';
    await actions.publishLegalAction({ id });
    const rows = await auditFor(id);
    expect(rows.map((r) => r.action)).toEqual([
      'legal.created',
      'legal.updated',
      'legal.published',
    ]);
    for (const row of rows) {
      expect(row.user_id).toBe(USER);
      expect(row.ip).toBe('203.0.113.9');
      expect(JSON.stringify(row.diff)).not.toContain('SECRET-LEGAL-TEXT');
    }
  });

  it('a refused publish of a published version writes nothing and changes nothing', async () => {
    const id = await newDraft();
    state.role = 'owner';
    await actions.publishLegalAction({ id });
    const before = (await auditFor(id)).length;
    expect(await actions.publishLegalAction({ id })).toEqual({
      ok: false,
      code: 'LEGAL_NOT_DRAFT',
    });
    expect(await actions.updateLegalDraftAction({ id, title: 'x', source: 'y' })).toEqual({
      ok: false,
      code: 'LEGAL_NOT_DRAFT',
    });
    expect(await actions.deleteLegalDraftAction({ id })).toEqual({
      ok: false,
      code: 'LEGAL_NOT_DRAFT',
    });
    expect((await auditFor(id)).length).toBe(before);
  });

  it('answers not found for an id that does not exist', async () => {
    state.role = 'owner';
    expect(
      await actions.publishLegalAction({ id: '00000000-0000-4000-8000-00000000dead' }),
    ).toEqual({ ok: false, code: 'LEGAL_NOT_FOUND' });
  });
});
