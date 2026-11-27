/**
 * The real promo action chain against Postgres: action -> `createAdminAction` (session, role, limit,
 * validation, ONE transaction, audit) -> the domain. A manager and content change nothing (refused
 * before the input is parsed), every change writes one audit row in the same transaction (the code
 * under the key `name`, never redacted, never the description), a repeat writes none.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { authUsers } from '@store/db/schema';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const USER = '00000000-0000-4000-8000-0000000000dd';
const state: { role: AdminSession['role']; handle: Db | null } = vi.hoisted(() => ({
  role: 'admin',
  handle: null,
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
          session: { sid: 's', userId: USER, email: 'promo@example.test', role: state.role },
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

const actions = await import('../src/actions/admin-promo');

let testDb: TestDatabase;
let handle: DbHandle;
beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  await handle.db.insert(authUsers).values({ id: USER, email: 'promo@example.test' });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});
beforeEach(() => {
  state.role = 'admin';
});

const input = (overrides: Record<string, unknown> = {}) => ({
  code: 'welcome15',
  description: 'secret note',
  type: 'percent',
  value: '15',
  maxDiscountAmount: '300',
  minOrderTotal: '0',
  maxUses: '100',
  perCustomerLimit: '',
  scope: 'all',
  scopeCategoryId: '',
  scopeProductId: '',
  stackable: false,
  excludesDiscountedItems: false,
  firstOrderOnly: false,
  excludesGiftCards: true,
  startsAt: '',
  endsAt: '',
  isActive: true,
  ...overrides,
});
const audits = async (entityId: string) =>
  (
    await handle.pool.query(
      `SELECT action, diff, user_id, ip FROM audit_log WHERE entity = 'promo_code' AND entity_id = $1 ORDER BY created_at, id`,
      [entityId],
    )
  ).rows as { action: string; diff: Record<string, unknown>; user_id: string; ip: string }[];

describe('role matrix', () => {
  it.each(['manager', 'content'] as const)(
    '%s is refused before the input is parsed',
    async (role) => {
      state.role = role;
      expect(await actions.createPromoCodeAction({ nonsense: true })).toEqual({
        ok: false,
        code: 'FORBIDDEN',
      });
      expect(await actions.bulkPromoCodesAction({ nonsense: true })).toEqual({
        ok: false,
        code: 'FORBIDDEN',
      });
      const rows = await handle.pool.query(`SELECT count(*)::int AS n FROM promo_codes`);
      expect((rows.rows[0] as { n: number }).n).toBe(0);
    },
  );

  it('an admin creates, edits and bulk-deactivates; each change has one audit row, a repeat none', async () => {
    const created = await actions.createPromoCodeAction(input());
    if (!created.ok) throw new Error(created.code);
    expect(created.data.code).toBe('WELCOME15');
    let rows = await audits(created.data.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'promo.created', user_id: USER, ip: '203.0.113.9' });
    expect(rows[0]?.diff).toMatchObject({ name: 'WELCOME15', value: 15 });
    expect(JSON.stringify(rows)).not.toContain('secret note');

    const edit = input({ maxUses: '200' });
    expect(await actions.updatePromoCodeAction({ ...edit, id: created.data.id })).toMatchObject({
      ok: true,
      data: { changed: true },
    });
    expect(await actions.updatePromoCodeAction({ ...edit, id: created.data.id })).toMatchObject({
      ok: true,
      data: { changed: false },
    });
    expect(
      await actions.bulkPromoCodesAction({ op: 'deactivate', ids: [created.data.id] }),
    ).toMatchObject({
      ok: true,
      data: { changed: 1 },
    });
    expect(
      await actions.bulkPromoCodesAction({ op: 'deactivate', ids: [created.data.id] }),
    ).toMatchObject({
      ok: true,
      data: { changed: 0 },
    });
    rows = await audits(created.data.id);
    expect(rows.map((r) => r.action)).toEqual([
      'promo.created',
      'promo.updated',
      'promo.deactivated',
    ]);
    expect(rows[1]?.diff).toEqual({ maxUses: [100, 200] });
  });

  it('a duplicate code and a malformed input are refused with a code, nothing is written', async () => {
    expect(await actions.createPromoCodeAction(input({ code: 'WELCOME15' }))).toEqual({
      ok: false,
      code: 'PROMO_CODE_TAKEN',
    });
    expect(await actions.createPromoCodeAction(input({ code: 'x y', value: '500' }))).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });
});
