/**
 * Promo-code admin on real Postgres (phase 11, slice A). The criteria that matter: the statistics are
 * COUNTED from `promo_code_redemptions` in state `consumed`; a redeemed code keeps its type, value and
 * scope; cancelling one order by two paths at the same moment frees the use ONCE (separate
 * connections, a barrier); the list filters, sorts and pages in SQL; a manager's shape has no author.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { cancelOrder } from '../src/orders/fulfilment.ts';
import { quoteCheckout } from '../src/orders/quote.ts';
import {
  bulkUpdatePromos,
  createPromo,
  exportPromoCodesCsv,
  listPromoCodes,
  PromoCodeTakenError,
  promoCreateSchema,
  promoUpdateSchema,
  PromoLimitBelowUsedError,
  PromoLockedError,
  readPromoStats,
  updatePromo,
} from '../src/promo-admin/index.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;
let variants: string[];
let seq = 0;
const USER = '00000000-0000-4000-8000-0000000000aa';

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  variants = world.fixture.variantIds;
  await admin.db.execute(
    sql`INSERT INTO auth_users (id, email) VALUES (${USER}, 'owner@example.test')`,
  );
});
afterEach(async () => {
  await world.close();
});

const form = (overrides: Record<string, unknown> = {}) => ({
  code: 'spring10',
  description: 'Spring',
  type: 'fixed',
  value: '1',
  maxDiscountAmount: '',
  minOrderTotal: '0',
  maxUses: '',
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

async function create(overrides: Record<string, unknown> = {}) {
  return await admin.db.transaction(
    async (tx) => await createPromo(tx, USER, promoCreateSchema.parse(form(overrides))),
  );
}

async function place(promoCode: string, email = 'b@example.com'): Promise<string> {
  seq += 1;
  const token = `tok-promo-admin-${String(seq)}`.padEnd(20, 'x');
  const variantId = variants[seq % variants.length] ?? '';
  await admin.db.execute(
    sql`UPDATE product_variants SET stock_quantity = 50 WHERE id = ${variantId}`,
  );
  await admin.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId, quantity: 1 });
  });
  const view = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await admin.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: view.intentId,
        ownerToken: token,
        contact: { email, phone: `+38050111${String(1000 + seq)}`, name: 'Buyer' },
        delivery: { method: 'pickup' },
        paymentProvider: 'mono',
        promoCode,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  return placed.orderId;
}

const cancel = async (orderId: string, source: string, handle: DbHandle = admin) =>
  await handle.db.transaction(
    async (tx) => await cancelOrder(tx, { orderId, source, reason: 'test' }),
  );

describe('create', () => {
  it('normalises the code and refuses a second one that differs only by case', async () => {
    const first = await create({ code: ' spring10 ' });
    expect(first.code).toBe('SPRING10');
    await expect(create({ code: 'Spring10' })).rejects.toBeInstanceOf(PromoCodeTakenError);
  });

  it('turns hryvnias into kopiykas and refuses a cap on a fixed code', async () => {
    const row = await create({ code: 'FIX50', value: '50,50' });
    const stored = await admin.db.execute<{ value: number }>(
      sql`SELECT value FROM promo_codes WHERE id = ${row.id}`,
    );
    expect(stored.rows[0]?.value).toBe(5050);
    expect(promoCreateSchema.safeParse(form({ maxDiscountAmount: '10' })).success).toBe(false);
    expect(promoCreateSchema.safeParse(form({ type: 'percent', value: '101' })).success).toBe(
      false,
    );
    expect(promoCreateSchema.safeParse(form({ scope: 'category' })).success).toBe(false);
  });
});

describe('statistics equal the consumed redemptions', () => {
  it('counts consumed redemptions, never the stored counter, and a cancel moves one to released', async () => {
    const { id } = await create({ code: 'STATS', value: '1' });
    const a = await place('STATS');
    await place('STATS');
    await place('STATS');
    await cancel(a, 'admin');

    const truth = await admin.db.execute<{ n: number; discount: string }>(
      sql`SELECT count(*)::int AS n, coalesce(sum(discount_amount), 0)::text AS discount
            FROM promo_code_redemptions WHERE promo_code_id = ${id} AND state = 'consumed'`,
    );
    const page = await listPromoCodes(admin.db, {}, true);
    const row = page.items.find((item) => item.id === id);
    expect(row?.consumedCount).toBe(truth.rows[0]?.n);
    expect(row?.consumedCount).toBe(2);
    expect(row?.usesCount).toBe(2);
    expect(row?.discountTotal).toBe(Number(truth.rows[0]?.discount));

    const stats = await readPromoStats(admin.db, id);
    expect(stats?.consumedCount).toBe(2);
    expect(stats?.releasedCount).toBe(1);
    expect(stats?.discountTotal).toBe(Number(truth.rows[0]?.discount));
    expect(stats?.orders).toHaveLength(2);

    // Drift is visible instead of hidden: corrupt the counter, the screen still shows the truth.
    await admin.db.execute(sql`UPDATE promo_codes SET uses_count = 0 WHERE id = ${id}`);
    const after = (await listPromoCodes(admin.db, {}, true)).items.find((item) => item.id === id);
    expect(after?.consumedCount).toBe(2);
    expect(after?.usesCount).toBe(0);
  });
});

describe('the freeze rule', () => {
  const update = async (id: string, overrides: Record<string, unknown>) =>
    await admin.db.transaction(
      async (tx) => await updatePromo(tx, promoUpdateSchema.parse({ ...form(overrides), id })),
    );

  it('an unused code can change anything; a redeemed one cannot change type, value or scope', async () => {
    const { id } = await create({ code: 'FREEZE', value: '1', maxUses: '5' });
    expect((await update(id, { value: '2', maxUses: '5' })).changed).toBe(true);
    await place('FREEZE');
    await expect(update(id, { value: '3', maxUses: '5' })).rejects.toBeInstanceOf(PromoLockedError);
    const refused: unknown = await update(id, { type: 'percent', value: '10', maxUses: '5' }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PromoLockedError);
    expect(refused instanceof PromoLockedError && refused.fields).toEqual(['type', 'value']);
    // Allowed: raise the limit, extend, deactivate.
    expect(
      (await update(id, { value: '2', maxUses: '9', endsAt: '2099-01-01T10:00', isActive: false }))
        .changed,
    ).toBe(true);
    // A repeat of the same state changes nothing.
    expect(
      (await update(id, { value: '2', maxUses: '9', endsAt: '2099-01-01T10:00', isActive: false }))
        .changed,
    ).toBe(false);
  });

  it('a released redemption still freezes the code, and the limit cannot drop below the uses', async () => {
    const { id } = await create({ code: 'HIST', value: '1', maxUses: '5' });
    const order = await place('HIST');
    await place('HIST');
    await expect(update(id, { value: '1', maxUses: '1' })).rejects.toBeInstanceOf(
      PromoLimitBelowUsedError,
    );
    await cancel(order, 'admin');
    await expect(update(id, { value: '9', maxUses: '5' })).rejects.toBeInstanceOf(PromoLockedError);
  });
});

describe('cancelling one order by two paths at once frees the use once', () => {
  it('uses_count drops by one, one redemption is released, never below zero', async () => {
    const { id } = await create({ code: 'RACE', value: '1', maxUses: '3' });
    for (let round = 0; round < 6; round += 1) {
      const orderId = await place('RACE');
      const before = await admin.db.execute<{ n: number }>(
        sql`SELECT uses_count AS n FROM promo_codes WHERE id = ${id}`,
      );
      const barrier = new Barrier(2);
      const run = async (source: string) => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await cancel(orderId, source, handle);
      };
      const results = await Promise.allSettled([run('worker'), run('webhook')]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(results.filter((r) => r.status === 'fulfilled' && r.value.changed)).toHaveLength(1);
      const after = await admin.db.execute<{ n: number }>(
        sql`SELECT uses_count AS n FROM promo_codes WHERE id = ${id}`,
      );
      expect(after.rows[0]?.n).toBe((before.rows[0]?.n ?? 0) - 1);
      const released = await admin.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM promo_code_redemptions WHERE order_id = ${orderId} AND state = 'released'`,
      );
      expect(released.rows[0]?.n).toBe(1);
    }
  });
});

describe('the list', () => {
  it('filters, sorts and pages in SQL; status comes from the database clock', async () => {
    await create({ code: 'AAA', description: 'summer sale' });
    await create({ code: 'BBB', type: 'percent', value: '10', isActive: false });
    await create({ code: 'CCC', maxUses: '1' });
    await place('CCC');
    await create({ code: 'DDD', endsAt: '2000-01-01T10:00' });
    await create({ code: 'EEE', startsAt: '2099-01-01T10:00' });
    const codes = async (filters: Parameters<typeof listPromoCodes>[1]) =>
      (await listPromoCodes(admin.db, filters, false)).items.map((i) => i.code);

    expect(await codes({ status: 'inactive' })).toEqual(['BBB']);
    expect(await codes({ status: 'exhausted' })).toEqual(['CCC']);
    expect(await codes({ status: 'ended' })).toEqual(['DDD']);
    expect(await codes({ status: 'upcoming' })).toEqual(['EEE']);
    expect(await codes({ status: 'active' })).toEqual(['AAA']);
    expect(await codes({ type: 'percent' })).toEqual(['BBB']);
    expect(await codes({ hasUses: true })).toEqual(['CCC']);
    expect(await codes({ q: 'SUMMER' })).toEqual(['AAA']);
    expect(await codes({ q: '%' })).toEqual([]);
    expect(await codes({ sort: 'code', dir: 'asc' })).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
    expect((await codes({ sort: 'uses', dir: 'desc' }))[0]).toBe('CCC');
    const paged = await listPromoCodes(admin.db, { sort: 'code', dir: 'asc', page: 2 }, false, 2);
    expect(paged.items.map((i) => i.code)).toEqual(['CCC', 'DDD']);
    expect(paged.total).toBe(5);
    expect(paged.totalPages).toBe(3);
  });

  it('a manager shape has no author; the manage shape has the e-mail', async () => {
    await create({ code: 'WHO' });
    const manager = JSON.stringify(await listPromoCodes(admin.db, {}, false));
    const manager2 = JSON.parse(manager) as { items: Record<string, unknown>[] };
    expect(manager2.items[0]).not.toHaveProperty('createdBy');
    expect(manager).not.toContain('owner@example.test');
    expect(JSON.stringify(await listPromoCodes(admin.db, {}, true))).toContain(
      'owner@example.test',
    );
  });

  it('the CSV has the same rows and neutralises a formula in the description', async () => {
    await create({ code: 'CSV1', description: '=HYPERLINK("x")' });
    const file = await exportPromoCodesCsv(admin.db, {});
    expect(file.rows).toBe(1);
    expect(file.csv).toContain('CSV1');
    expect(file.csv).not.toMatch(/(^|,|\n)=HYPERLINK/);
  });
});

describe('bulk', () => {
  it('deactivates, and extends only codes that end earlier; a repeat changes nothing', async () => {
    const a = await create({ code: 'BULKA', endsAt: '2030-01-01T10:00' });
    const b = await create({ code: 'BULKB', endsAt: '2040-01-01T10:00' });
    const run = async (input: Parameters<typeof bulkUpdatePromos>[1]) =>
      await admin.db.transaction(async (tx) => await bulkUpdatePromos(tx, input));
    const extended = await run({ op: 'extend', ids: [a.id, b.id], endsAt: '2035-01-01T10:00' });
    expect(extended.changed.map((c) => c.code)).toEqual(['BULKA']);
    expect(
      (await run({ op: 'extend', ids: [a.id, b.id], endsAt: '2035-01-01T10:00' })).changed,
    ).toEqual([]);
    expect((await run({ op: 'deactivate', ids: [a.id, b.id] })).changed).toHaveLength(2);
    expect((await run({ op: 'deactivate', ids: [a.id, b.id] })).changed).toHaveLength(0);
  });
});

describe('the oracle stays closed (PROMO_CODES.md section 2)', () => {
  it('a code that does not exist and a code whose limit is exhausted get the identical serialized answer', async () => {
    await create({ code: 'GONE', maxUses: '1' });
    await place('GONE');
    await create({ code: 'OFF', isActive: false });
    await create({ code: 'OLD', endsAt: '2000-01-01T10:00' });
    await create({ code: 'BIG', minOrderTotal: '99999' });
    const token = 'tok-oracle-admin-xxxx';
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, { cartToken: token, variantId: variants[0] ?? '', quantity: 1 });
    });
    const view = await admin.db.transaction(
      async (tx) => await startCheckout(tx, { cartToken: token }),
    );
    const answer = async (code: string) => {
      const result = await admin.db.transaction(
        async (tx) =>
          await quoteCheckout(tx, {
            cartToken: token,
            intentId: view.intentId,
            delivery: 'pickup',
            promoCode: code,
          }),
      );
      // The echoed code is what the buyer typed; everything else must be byte-identical.
      return JSON.stringify({ ...result, promo: { ...result.promo, code: 'X' } });
    };
    const reference = await answer('DOES-NOT-EXIST');
    expect(reference).toContain('"promo":{"code":"X","accepted":false}');
    for (const code of ['GONE', 'OFF', 'OLD', 'BIG']) expect(await answer(code)).toBe(reference);
  });
});
