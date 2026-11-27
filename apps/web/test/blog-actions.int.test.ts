/**
 * The real blog action chain against Postgres: role matrix (a manager touches nothing, refused before the input is
 * parsed), audit rows that never hold the text, the cache tags and the proxy's address set dropped after a change only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { authUsers } from '@store/db/schema';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const USER = '00000000-0000-4000-8000-0000000000b3';
const state = vi.hoisted<{
  role: AdminSession['role'];
  handle: Db | null;
  tags: string[];
  gate: number;
}>(() => ({
  role: 'content',
  handle: null,
  tags: [],
  gate: 0,
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
          session: { sid: 's', userId: USER, email: 'b@example.test', role: state.role },
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
  updateTags: (tags: readonly string[]) => {
    state.tags.push(...tags);
  },
}));
vi.mock('@/lib/blog-gate', () => ({
  knownBlogPages: {
    invalidate: () => {
      state.gate += 1;
    },
  },
}));

const actions = await import('../src/actions/admin-blog');

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
  state.gate = 0;
});

const input = (overrides: Record<string, unknown> = {}) => ({
  slug: 'first-post',
  titleUk: 'Перший',
  titleEn: 'First',
  excerptUk: '',
  excerptEn: '',
  contentUk: 'SECRET body text uk',
  contentEn: 'SECRET body text en',
  author: '',
  tags: 'news',
  metaTitleUk: '',
  metaTitleEn: '',
  metaDescriptionUk: '',
  metaDescriptionEn: '',
  publishedAt: '',
  publishNow: false,
  unpublish: false,
  ...overrides,
});
const audits = async (id: string) =>
  (
    await handle.pool.query<{ action: string; diff: unknown }>(
      `SELECT action, diff FROM audit_log WHERE entity = 'blog_post' AND entity_id = $1 ORDER BY created_at, id`,
      [id],
    )
  ).rows;

describe('role matrix, audit and cache', () => {
  it('a manager is refused before parsing; content creates, edits, publishes, deletes; the text is never audited', async () => {
    state.role = 'manager';
    expect(await actions.createPostAction({ nonsense: true })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await actions.deletePostAction({ nonsense: true })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(state.tags).toEqual([]);
    expect(state.gate).toBe(0);

    state.role = 'content';
    const created = await actions.createPostAction(input());
    if (!created.ok) throw new Error(created.code);
    expect(state.tags).toEqual(['blog', 'blog:first-post']);
    expect(state.gate).toBe(1);
    expect(await actions.createPostAction(input())).toEqual({ ok: false, code: 'BLOG_SLUG_TAKEN' });
    expect(await actions.createPostAction(input({ slug: 'Bad Slug' }))).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });

    state.tags.length = 0;
    const rest: Record<string, unknown> = input();
    delete rest['slug'];
    // The same state again changes nothing: no audit row, no cache drop.
    expect(await actions.updatePostAction({ ...rest, id: created.data.id })).toMatchObject({
      ok: true,
      data: { changed: false },
    });
    expect(state.tags).toEqual([]);
    expect(
      await actions.updatePostAction({ ...rest, id: created.data.id, publishNow: true }),
    ).toMatchObject({ data: { changed: true } });
    expect(state.tags).toEqual(['blog', 'blog:first-post']);
    expect(
      await actions.updatePostAction({
        ...rest,
        id: created.data.id,
        contentUk: '',
        contentEn: '',
        publishNow: true,
      }),
    ).toEqual({
      ok: false,
      code: 'BLOG_EMPTY',
    });
    expect(await actions.deletePostAction({ id: created.data.id })).toMatchObject({ ok: true });

    const rows = await audits(created.data.id);
    expect(rows.map((r) => r.action)).toEqual(['blog.created', 'blog.updated', 'blog.deleted']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });
});
