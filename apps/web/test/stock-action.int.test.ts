/**
 * The real stock action chain against Postgres: `adjustStockAction` -> `catalogAction` ->
 * `createAdminAction` (role, validation, one transaction, audit) -> `adjustVariantStock`.
 * Only the request-bound inputs (session, Origin, cookies) are supplied by the test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { authUsers, settings } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const state: { role: AdminSession['role']; handle: Db | null } = vi.hoisted(() => ({
  role: 'manager',
  handle: null,
}));

// The action imports the wrapper through the web app's `@/` alias, which this project does not
// resolve: point it at the real module by path.
vi.mock('@/lib/admin/catalog-action', async () => await import('../src/lib/admin/catalog-action'));
vi.mock('../src/lib/admin/invalidate', () => ({ invalidateTags: vi.fn() }));
vi.mock('../src/lib/admin/bound-action', async () => {
  const { createAdminAction: create } = await import('../src/lib/admin/action');
  const { createRateLimiter: limiter } = await import('../src/lib/rate-limit');
  return {
    adminAction: create({
      originOk: () => Promise.resolve(true),
      session: () =>
        Promise.resolve({
          kind: 'full',
          session: {
            sid: 's',
            userId: '00000000-0000-4000-8000-0000000000aa',
            email: 'stock@example.test',
            role: state.role,
          },
        } satisfies ResolvedSession),
      transaction: async (fn) => {
        if (state.handle === null) throw new Error('no database');
        return await state.handle.transaction(fn);
      },
      client: () => Promise.resolve('203.0.113.9'),
      limiter: limiter({ limit: 1_000, windowMs: 60_000 }),
    }),
  };
});

const { adjustStockAction } = await import('../src/actions/admin-stock');

let testDb: TestDatabase;
let handle: DbHandle;
let variantId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  variantId = (
    await handle.db.transaction(async (tx) => {
      await tx.insert(settings).values({
        key: 'payment_providers',
        value: { mono: true, wayforpay: true, cod: true, bank_transfer: true },
      });
      return await seedMoneySkeleton(tx);
    })
  ).variantIds[0];
  await handle.db
    .insert(authUsers)
    .values({ id: '00000000-0000-4000-8000-0000000000aa', email: 'stock@example.test' });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});
beforeEach(async () => {
  state.role = 'manager';
  await handle.pool.query(
    'UPDATE product_variants SET stock_quantity = 10, reserved_quantity = 0 WHERE id = $1',
    [variantId],
  );
});

const count = async (table: string, column: string): Promise<number> =>
  Number(
    (
      await handle.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`,
        [variantId],
      )
    ).rows[0]?.n ?? 0,
  );
const quantity = async (): Promise<number | undefined> =>
  (
    await handle.pool.query<{ q: number }>(
      'SELECT stock_quantity AS q FROM product_variants WHERE id = $1',
      [variantId],
    )
  ).rows[0]?.q;
const auditRows = async () => await count('audit_log', 'entity_id');
const historyRows = async () => await count('stock_adjustments', 'variant_id');

const input = (overrides: Record<string, unknown> = {}) => ({
  variantId,
  mode: 'delta',
  amount: 2,
  reason: 'receipt',
  requestId: crypto.randomUUID(),
  ...overrides,
});

describe('adjustStockAction through the real chain', () => {
  it('owner, admin and manager may adjust; content is FORBIDDEN and nothing changes', async () => {
    const roles: AdminSession['role'][] = ['owner', 'admin', 'manager'];
    for (const role of roles) {
      state.role = role;
      const result = await adjustStockAction(input());
      expect(result.ok).toBe(true);
    }
    expect(await quantity()).toBe(16);
    const audited = await auditRows();
    state.role = 'content';
    expect(await adjustStockAction(input())).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await quantity()).toBe(16);
    expect(await auditRows()).toBe(audited);
  });

  it('a replayed request id changes the stock once and writes exactly one audit row', async () => {
    const auditBefore = await auditRows();
    const same = input({ amount: 2 });
    expect((await adjustStockAction(same)).ok).toBe(true);
    expect((await adjustStockAction(same)).ok).toBe(true);
    expect(await quantity()).toBe(12);
    expect(await historyRows()).toBeGreaterThan(0);
    expect((await auditRows()) - auditBefore).toBe(1);
  });

  it('a stocktake to the current quantity writes no audit row', async () => {
    const auditBefore = await auditRows();
    const result = await adjustStockAction(input({ mode: 'set', amount: 10, reason: 'stocktake' }));
    expect(result.ok).toBe(true);
    expect(await auditRows()).toBe(auditBefore);
  });

  it('a refused change (below reserved) leaves stock, history and audit untouched', async () => {
    await handle.pool.query('UPDATE product_variants SET reserved_quantity = 8 WHERE id = $1', [
      variantId,
    ]);
    const auditBefore = await auditRows();
    const historyBefore = await historyRows();
    const result = await adjustStockAction(input({ mode: 'set', amount: 3, reason: 'stocktake' }));
    expect(result).toEqual({ ok: false, code: 'STOCK_BELOW_RESERVED' });
    expect(await quantity()).toBe(10);
    expect(await auditRows()).toBe(auditBefore);
    expect(await historyRows()).toBe(historyBefore);
  });
});
