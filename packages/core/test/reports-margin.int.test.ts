/**
 * Margin on real Postgres: event-dated from the cost snapshots, the seller-paid carrier cost only,
 * returns and cancellations reverse at their own date, an unknown cost is never zero.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, subtract, sum, ZERO } from '@store/shared/money';
import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { parsePeriod } from '../src/reports/period.ts';
import { readMargin, readMarginBreakdown } from '../src/reports/margin.ts';
import { insertOrder } from './reports-fixture.ts';

let testDb: TestDatabase;
let handle: DbHandle;
const db = () => handle.db;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

/** One isolated month per scenario keeps the expectations independent. */
const month = (n: number) => ({
  period: parsePeriod({
    from: `2026-${String(n).padStart(2, '0')}-01`,
    to: `2026-${String(n).padStart(2, '0')}-28`,
  }),
  at: (day: number, time = '10:00:00Z') =>
    `2026-${String(n).padStart(2, '0')}-${String(day).padStart(2, '0')}T${time}`,
});

describe('margin rules', () => {
  it('goods margin from the snapshots; a line discount is already in the line total', async () => {
    const m = month(1);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [
          { quantity: 2, price: 50_000, discount: 10_000, cost: 20_000 }, // revenue 90 000, cost 40 000
          { quantity: 1, price: 30_000, cost: 12_000 }, // revenue 30 000, cost 12 000
        ],
        captures: [{ at: m.at(5), amount: 120_000 }],
      });
    });
    const { totals } = await readMargin(db(), m.period);
    expect(totals).toMatchObject({
      goodsRevenue: 120_000,
      costOfGoods: 52_000,
      shippingCost: 0,
      margin: 68_000,
      marginBps: 5_667,
      noCostLines: 0,
    });
  });

  it('the carrier cost counts ONLY when the sender paid; a missing cost is counted, not zero', async () => {
    const m = month(2);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 100_000, cost: 40_000 }],
        shippingPaidBy: 'sender',
        shippingCostActual: 7_000,
        captures: [{ at: m.at(3), amount: 100_000 }],
      });
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 100_000, cost: 40_000 }],
        shippingPaidBy: 'recipient',
        shippingCostActual: 9_900, // the recipient paid the tariff: NOT the seller's cost
        captures: [{ at: m.at(4), amount: 100_000 }],
      });
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 100_000, cost: 40_000 }],
        shippingPaidBy: 'sender',
        shippingCostActual: null, // no waybill cost yet
        captures: [{ at: m.at(5), amount: 100_000 }],
      });
    });
    const { totals } = await readMargin(db(), m.period);
    expect(totals.shippingCost).toBe(7_000);
    expect(totals.noShippingCostOrders).toBe(1);
    expect(totals.margin).toBe(300_000 - 120_000 - 7_000);
  });

  it('a line without a cost snapshot is excluded and counted, never treated as zero cost', async () => {
    const m = month(3);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [
          { quantity: 1, price: 80_000, cost: 30_000 },
          { quantity: 3, price: 10_000, cost: null },
        ],
        captures: [{ at: m.at(5), amount: 110_000 }],
      });
    });
    const { totals } = await readMargin(db(), m.period);
    expect(totals).toMatchObject({
      goodsRevenue: 80_000,
      costOfGoods: 30_000,
      margin: 50_000,
      noCostLines: 1,
      noCostRevenue: 30_000,
    });
  });

  it('a received return reverses the line share and the cost of the RESTOCKED units only', async () => {
    const m = month(4);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [{ quantity: 3, price: 33_333, cost: 10_000 }], // line 99 999, cost 30 000
        captures: [{ at: m.at(2), amount: 99_999 }],
        returns: [
          // 2 units received, 1 restocked (the other is defective): revenue share 66 666, cost back 10 000
          { receivedAt: m.at(20), items: [{ line: 0, received: 2, restocked: 1 }] },
        ],
      });
    });
    const early = await readMargin(db(), parsePeriod({ from: '2026-04-01', to: '2026-04-10' }));
    expect(early.totals).toMatchObject({
      goodsRevenue: 99_999,
      costOfGoods: 30_000,
      margin: 69_999,
    });
    const late = await readMargin(db(), parsePeriod({ from: '2026-04-11', to: '2026-04-28' }));
    expect(late.totals).toMatchObject({
      goodsRevenue: -66_666,
      costOfGoods: -10_000,
      margin: -56_666,
    });
    const whole = await readMargin(db(), m.period);
    expect(whole.totals.margin).toBe(69_999 - 56_666);
  });

  it('a return received AFTER its refund lowers the period of the receipt, not of the refund', async () => {
    const m = month(5);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 60_000, cost: 25_000 }],
        captures: [{ at: m.at(2), amount: 60_000 }],
        returns: [{ receivedAt: m.at(25), items: [{ line: 0, received: 1, restocked: 1 }] }],
        refunds: [{ at: m.at(10), amount: 60_000, returnIndex: 0 }],
      });
    });
    const refundWeek = await readMargin(
      db(),
      parsePeriod({ from: '2026-05-08', to: '2026-05-15' }),
    );
    expect(refundWeek.totals.margin).toBe(0);
    expect(refundWeek.totals.otherRefunds).toBe(0); // tied to a return that was received: not a goodwill refund
    const receiptWeek = await readMargin(
      db(),
      parsePeriod({ from: '2026-05-20', to: '2026-05-28' }),
    );
    expect(receiptWeek.totals.margin).toBe(-35_000);
  });

  it('a paid order that is cancelled reverses its goods at the cancellation date', async () => {
    const m = month(6);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        status: 'cancelled',
        cancelledAt: m.at(20),
        lines: [{ quantity: 1, price: 50_000, cost: 20_000 }],
        captures: [{ at: m.at(2), amount: 50_000 }],
        refunds: [{ at: m.at(21), amount: 50_000 }],
      });
    });
    const sale = await readMargin(db(), parsePeriod({ from: '2026-06-01', to: '2026-06-10' }));
    expect(sale.totals.margin).toBe(30_000);
    const cancel = await readMargin(db(), parsePeriod({ from: '2026-06-11', to: '2026-06-28' }));
    expect(cancel.totals.margin).toBe(-30_000);
    expect(cancel.totals.otherRefunds).toBe(0); // the refund of a cancelled order is covered by the reversal
  });

  it('a COD order has no sale, so its return reverses nothing', async () => {
    const m = month(7);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        provider: 'cod',
        status: 'returned',
        lines: [{ quantity: 1, price: 50_000, cost: 20_000 }],
        returns: [{ receivedAt: m.at(15), items: [{ line: 0, received: 1, restocked: 1 }] }],
      });
    });
    const { totals } = await readMargin(db(), m.period);
    expect(totals).toMatchObject({ goodsRevenue: 0, costOfGoods: 0, margin: 0, marginBps: null });
  });

  it('a goodwill refund (no return, no cancellation) is reported, not hidden', async () => {
    const m = month(8);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 50_000, cost: 20_000 }],
        captures: [{ at: m.at(2), amount: 50_000 }],
        refunds: [
          { at: m.at(6), amount: 5_000 },
          { at: m.at(7), amount: 2_000, state: 'failed' },
        ],
      });
    });
    const { totals } = await readMargin(db(), m.period);
    expect(totals.otherRefunds).toBe(5_000);
    expect(totals.margin).toBe(30_000);
  });

  it('a sale at 00:30 Kyiv time belongs to the new Kyiv day', async () => {
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 10_000, cost: 4_000 }],
        captures: [{ at: '2026-09-09T21:30:00Z', amount: 10_000 }], // 10 Sep 00:30 Kyiv (UTC+3)
      });
    });
    const sep9 = await readMargin(db(), parsePeriod({ from: '2026-09-09', to: '2026-09-09' }));
    const sep10 = await readMargin(db(), parsePeriod({ from: '2026-09-10', to: '2026-09-10' }));
    expect(sep9.totals.margin).toBe(0);
    expect(sep10.totals.margin).toBe(6_000);
  });

  it('an empty period has no percentage and no rows', async () => {
    const empty = parsePeriod({ from: '2026-12-01', to: '2026-12-31' });
    const { totals } = await readMargin(db(), empty);
    expect(totals).toMatchObject({ margin: 0, marginBps: null, noCostLines: 0 });
    expect(await readMarginBreakdown(db(), empty, { by: 'product' })).toEqual({
      rows: [],
      rest: null,
    });
  });
});

describe('breakdowns add up to the total', () => {
  it('products and categories, with an all-other row when the list is cut', async () => {
    const m = month(10);
    await db().transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [
          {
            uid: '00000000-0000-4000-8000-000000000001',
            name: 'A',
            category: 'Bras',
            quantity: 1,
            price: 70_000,
            cost: 30_000,
          },
          {
            uid: '00000000-0000-4000-8000-000000000002',
            name: 'B',
            category: 'Bras',
            quantity: 2,
            price: 20_000,
            cost: 15_000,
          },
          {
            uid: '00000000-0000-4000-8000-000000000003',
            name: 'C',
            category: 'Robes',
            quantity: 1,
            price: 40_000,
            cost: 25_001,
          },
          {
            uid: '00000000-0000-4000-8000-000000000004',
            name: 'D',
            category: 'Robes',
            quantity: 1,
            price: 9_000,
            cost: null,
          },
        ],
        captures: [{ at: m.at(3), amount: 159_000 }],
      });
    });
    const total = (await readMargin(db(), m.period)).totals;
    const goods = subtract(total.goodsRevenue, total.costOfGoods);
    const products = await readMarginBreakdown(db(), m.period, { by: 'product', limit: 100 });
    expect(products.rows.map((r) => r.name)).toEqual(['A', 'C', 'B']); // best margin first; D has no cost data
    expect(sum(products.rows.map((r) => r.margin))).toBe(goods);
    const cut = await readMarginBreakdown(db(), m.period, { by: 'product', limit: 1 });
    expect(cut.rows).toHaveLength(1);
    expect(cut.rest).not.toBeNull();
    expect(add(sum(cut.rows.map((r) => r.margin)), cut.rest?.margin ?? ZERO)).toBe(goods);
    const categories = await readMarginBreakdown(db(), m.period, { by: 'category' });
    expect(categories.rows.map((r) => r.key)).toEqual(['Bras', 'Robes']);
    expect(sum(categories.rows.map((r) => r.margin))).toBe(goods);
  });
});
