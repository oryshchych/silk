/**
 * The real banner action chain and the picture upload route against Postgres: role matrix (a manager touches nothing,
 * refused before the input is parsed), audit rows, the cache tag dropped only after a change, the upload route's
 * checks (session, role, banner exists, the bytes are an image), the stored pictures and the removal of a replaced
 * picture's files. The storage is an in-memory fake; the image conversion is the real one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { authUsers } from '@store/db/schema';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { samplePhoto } from '../../../packages/media/test/sample-image';

const USER = '00000000-0000-4000-8000-0000000000bb';
const state = vi.hoisted<{
  role: AdminSession['role'] | null;
  handle: Db | null;
  tags: string[];
  files: Map<string, number>;
}>(() => ({ role: 'content', handle: null, tags: [], files: new Map() }));

async function wired() {
  const { createAdminAction: create } = await import('../src/lib/admin/action');
  const { createRateLimiter: limiter } = await import('../src/lib/rate-limit');
  return {
    requestOriginOk: () => Promise.resolve(true),
    adminAction: create({
      originOk: () => Promise.resolve(true),
      session: () =>
        Promise.resolve(
          state.role === null
            ? null
            : ({
                kind: 'full',
                session: { sid: 's', userId: USER, email: 'b@example.test', role: state.role },
              } satisfies ResolvedSession),
        ),
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
  // Both paths expire at once: the server actions call `updateTags`, the upload route `expireTags`.
  updateTags: (tags: readonly string[]) => {
    state.tags.push(...tags);
  },
  expireTags: (tags: readonly string[]) => {
    state.tags.push(...tags);
  },
}));
vi.mock('@/lib/admin/session', () => ({
  currentSession: () =>
    Promise.resolve(
      state.role === null
        ? null
        : {
            kind: 'full',
            session: { sid: 's', userId: USER, email: 'b@example.test', role: state.role },
          },
    ),
}));
vi.mock('@/lib/db', () => ({ getDb: () => Promise.resolve(state.handle) }));
vi.mock('@/lib/request-limits', () => ({
  checkRequestLimit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock('@/lib/media', () => ({
  mediaConfig: () =>
    Promise.resolve({
      publicBase: 'https://media.test',
      storage: {
        put: (key: string, body: Buffer) => {
          state.files.set(key, body.length);
          return Promise.resolve();
        },
        remove: (key: string) => {
          state.files.delete(key);
          return Promise.resolve();
        },
      },
    }),
}));

const actions = await import('../src/actions/admin-banners');
const route = await import('../src/app/admin/upload/banner-image/route');

let testDb: TestDatabase;
let handle: DbHandle;
beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  await handle.db.insert(authUsers).values({ id: USER, email: 'b@example.test' });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});
beforeEach(() => {
  state.role = 'content';
  state.tags.length = 0;
});

const input = (overrides: Record<string, unknown> = {}) => ({
  titleUk: 'Весна',
  titleEn: 'Spring',
  subtitleUk: '',
  subtitleEn: '',
  ctaLabelUk: '',
  ctaLabelEn: '',
  altUk: 'Опис',
  altEn: 'Description',
  href: '/category/bras',
  startsAt: '',
  endsAt: '',
  sortOrder: '0',
  isActive: false,
  ...overrides,
});
const audits = async (id: string) =>
  (
    await handle.pool.query<{ action: string; diff: unknown }>(
      `SELECT action, diff FROM audit_log WHERE entity = 'banner' AND entity_id = $1 ORDER BY created_at, id`,
      [id],
    )
  ).rows;
const upload = async (id: string, slot: string, body: Buffer | string) =>
  await route.POST(
    new Request(`http://localhost/admin/upload/banner-image?bannerId=${id}&slot=${slot}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : new Uint8Array(body),
      headers: { 'content-length': String(Buffer.byteLength(body)) },
    }),
  );

describe('role matrix and audit', () => {
  it('a manager is refused before the input is parsed; content creates, edits, deletes; each change is audited', async () => {
    state.role = 'manager';
    expect(await actions.createBannerAction({ nonsense: true })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await actions.deleteBannerAction({ nonsense: true })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(state.tags).toEqual([]);
    state.role = 'content';
    const created = await actions.createBannerAction(input());
    if (!created.ok) throw new Error(created.code);
    expect(state.tags).toEqual(['banners']);
    state.tags.length = 0;
    // A repeat of the same state changes nothing: no audit row, no cache drop.
    expect(await actions.updateBannerAction({ ...input(), id: created.data.id })).toMatchObject({
      ok: true,
      data: { changed: false },
    });
    expect(state.tags).toEqual([]);
    expect(
      await actions.updateBannerAction({ ...input({ isActive: true }), id: created.data.id }),
    ).toEqual({ ok: false, code: 'BANNER_INCOMPLETE' });
    expect(
      await actions.updateBannerAction({
        ...input({ href: 'https://evil.example' }),
        id: created.data.id,
      }),
    ).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(
      await actions.updateBannerAction({ ...input({ sortOrder: '3' }), id: created.data.id }),
    ).toMatchObject({ data: { changed: true } });
    expect(state.tags).toEqual(['banners']);
    expect(await actions.deleteBannerAction({ id: created.data.id })).toMatchObject({ ok: true });
    expect((await audits(created.data.id)).map((r) => r.action)).toEqual([
      'banner.created',
      'banner.updated',
      'banner.deleted',
    ]);
  });
});

describe('the picture upload route', () => {
  it('stores renditions and the row, replaces a picture and removes the old files; both slots make the banner completable', async () => {
    const created = await actions.createBannerAction(input());
    if (!created.ok) throw new Error(created.code);
    const id = created.data.id;
    const first = await upload(id, 'desktop', await samplePhoto(1800, 700));
    expect(first.status).toBe(201);
    expect(state.files.size).toBe(6);
    const row = await handle.pool.query<{ url: string; w: number; h: number }>(
      `SELECT image_desktop_url AS url, image_desktop_width AS w, image_desktop_height AS h FROM banners WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.url).toMatch(
      new RegExp(`^https://media.test/banners/${id}/[0-9a-f-]{36}/full\\.webp$`),
    );
    expect([row.rows[0]?.w, row.rows[0]?.h]).toEqual([1800, 700]);
    const second = await upload(id, 'desktop', await samplePhoto(1700, 600));
    expect(second.status).toBe(201);
    expect(state.files.size).toBe(6);
    expect((await upload(id, 'mobile', await samplePhoto(800, 1100))).status).toBe(201);
    expect(state.files.size).toBe(12);
    expect(await actions.updateBannerAction({ ...input({ isActive: true }), id })).toMatchObject({
      ok: true,
      data: { changed: true },
    });
    expect((await audits(id)).map((r) => r.action)).toContain('banner.image_set');
    expect(state.tags.filter((t) => t === 'banners').length).toBeGreaterThanOrEqual(4);
  });

  it('deleting a banner removes its picture files after the commit', async () => {
    const created = await actions.createBannerAction(input());
    if (!created.ok) throw new Error(created.code);
    const before = state.files.size;
    expect((await upload(created.data.id, 'desktop', await samplePhoto(1800, 700))).status).toBe(
      201,
    );
    expect(state.files.size).toBe(before + 6);
    expect(await actions.deleteBannerAction({ id: created.data.id })).toEqual({
      ok: true,
      data: { id: created.data.id },
    });
    expect(state.files.size).toBe(before);
  });

  it('a repeated query parameter is refused', async () => {
    const created = await actions.createBannerAction(input());
    if (!created.ok) throw new Error(created.code);
    const response = await route.POST(
      new Request(
        `http://localhost/admin/upload/banner-image?bannerId=${created.data.id}&slot=desktop&slot=mobile`,
        { method: 'POST', body: 'x', headers: { 'content-length': '1' } },
      ),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a stranger, a manager, an unknown banner and bytes that are not a picture, storing nothing', async () => {
    const created = await actions.createBannerAction(input());
    if (!created.ok) throw new Error(created.code);
    const before = state.files.size;
    state.role = null;
    expect((await upload(created.data.id, 'desktop', 'x')).status).toBe(401);
    state.role = 'manager';
    expect((await upload(created.data.id, 'desktop', 'x')).status).toBe(403);
    state.role = 'content';
    expect((await upload('00000000-0000-4000-8000-0000000000f1', 'desktop', 'x')).status).toBe(404);
    expect((await upload(created.data.id, 'tablet', 'x')).status).toBe(400);
    expect((await upload(created.data.id, 'desktop', 'this is not a picture')).status).toBe(415);
    expect(state.files.size).toBe(before);
  });
});
