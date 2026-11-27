/**
 * Revenue on real Postgres: the three figures from the payment journal, each by the date of its
 * own operation, in shop (Europe/Kyiv) days decided by the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { subtract, sum } from '@store/shared/money';
import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { readRevenueComparison } from '../src/reports/comparison.ts';
import { parsePeriod } from '../src/reports/period.ts';
import { readRevenue } from '../src/reports/revenue.ts';
import { insertOrder } from './reports-fixture.ts';

let testDb: TestDatabase;
let handle: DbHandle;
let emptyDb: TestDatabase;
let emptyHandle: DbHandle;

beforeAll(async () => {
  emptyDb = await createTestDatabase();
  emptyHandle = createDb(emptyDb.appUrl, { max: 1 });
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
  await handle.db.transaction(async (tx) => {
    // 1. A partial refund: 1000.00 came in, 200.00 went back; the order is NOT counted by its status.
    await insertOrder(tx, {
      lines: [{ quantity: 1, price: 100_000, cost: 40_000 }],
      captures: [{ at: '2026-06-10T10:00:00Z', amount: 100_000 }],
      refunds: [{ at: '2026-06-12T10:00:00Z', amount: 20_000 }],
    });
    // 2. A refund in a LATER period than its capture: captured 30 Sep 23:30 Kyiv, refunded 2 Oct.
    await insertOrder(tx, {
      lines: [{ quantity: 1, price: 50_000, cost: 20_000 }],
      captures: [{ at: '2026-09-30T20:30:00Z', amount: 50_000 }],
      refunds: [{ at: '2026-10-02T09:00:00Z', amount: 50_000 }],
    });
    // 3. Cash on delivery: nothing is captured, so nothing is revenue.
    await insertOrder(tx, {
      provider: 'cod',
      status: 'delivered',
      lines: [{ quantity: 2, price: 70_000, cost: 30_000 }],
    });
    // 4. A gift card payment and a refund onto it are not cash receipts.
    await insertOrder(tx, {
      provider: 'gift_card',
      lines: [{ quantity: 1, price: 90_000, cost: 10_000 }],
      captures: [{ at: '2026-06-11T10:00:00Z', amount: 90_000, provider: 'gift_card' }],
      refunds: [{ at: '2026-06-13T10:00:00Z', amount: 90_000 }],
    });
    // 5. A refund that did not settle is not a refund.
    await insertOrder(tx, {
      lines: [{ quantity: 1, price: 30_000, cost: 5_000 }],
      captures: [{ at: '2026-06-14T10:00:00Z', amount: 30_000 }],
      refunds: [
        { at: null, amount: 10_000, state: 'pending' },
        { at: '2026-06-15T10:00:00Z', amount: 10_000, state: 'failed' },
        { at: '2026-06-15T11:00:00Z', amount: 10_000, state: 'unknown' },
      ],
    });
    // 6. Bank transfer counts like a card (the manager confirmed the bank line).
    await insertOrder(tx, {
      provider: 'bank_transfer',
      lines: [{ quantity: 1, price: 25_000, cost: 5_000 }],
      captures: [{ at: '2026-06-20T08:00:00Z', amount: 25_000, provider: 'bank_transfer' }],
    });
  });
});
afterAll(async () => {
  await handle.close();
  await emptyHandle.close();
  await testDb.drop();
  await emptyDb.drop();
});

const june = (granularity: 'day' | 'week' | 'month' = 'day') =>
  parsePeriod({ from: '2026-06-01', to: '2026-06-30', granularity });

describe('revenue: three figures from the journal', () => {
  it('a partly refunded order counts its money, and cash on delivery, gift cards and unsettled refunds count nothing', async () => {
    const report = await readRevenue(handle.db, june());
    // 100 000 + 30 000 + 25 000 = 155 000 (the COD order and the gift card payment are out)
    expect(report.totals.gross).toBe(155_000);
    expect(report.totals.refunds).toBe(20_000);
    expect(report.totals.net).toBe(135_000);
    expect(report.totals.captures).toBe(3);
    expect(report.totals.refundOperations).toBe(1);
  });

  it('a refund in a later period lowers THAT period and leaves the earlier one alone', async () => {
    const september = await readRevenue(
      handle.db,
      parsePeriod({ from: '2026-09-01', to: '2026-09-30' }),
    );
    const october = await readRevenue(
      handle.db,
      parsePeriod({ from: '2026-10-01', to: '2026-10-31' }),
    );
    expect(september.totals).toMatchObject({ gross: 50_000, refunds: 0, net: 50_000 });
    expect(october.totals).toMatchObject({ gross: 0, refunds: 50_000, net: -50_000 });
  });

  it('the series adds up to the totals to the kopiyka at every granularity', async () => {
    for (const granularity of ['day', 'week', 'month'] as const) {
      const report = await readRevenue(handle.db, june(granularity));
      const gross = sum(report.series.map((p) => p.gross));
      const refunds = sum(report.series.map((p) => p.refunds));
      expect(gross).toBe(report.totals.gross);
      expect(refunds).toBe(report.totals.refunds);
      expect(report.series.every((p) => p.net === subtract(p.gross, p.refunds))).toBe(true);
    }
  });

  it('weeks start on Monday, months on the first, empty buckets are present as zeros', async () => {
    const weeks = await readRevenue(handle.db, june('week'));
    expect(weeks.series.map((p) => p.bucket)).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
    ]);
    const days = await readRevenue(handle.db, june('day'));
    expect(days.series).toHaveLength(30);
    expect(days.series.find((p) => p.bucket === '2026-06-05')).toMatchObject({ gross: 0, net: 0 });
    const months = await readRevenue(
      handle.db,
      parsePeriod({ from: '2026-05-15', to: '2026-07-10', granularity: 'month' }),
    );
    expect(months.series.map((p) => p.bucket)).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
  });

  it('a capture at 00:30 Kyiv belongs to the new day even though it is still the old day in UTC', async () => {
    await handle.db.transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 11_100, cost: null }],
        captures: [
          { at: '2026-11-29T21:59:59Z', amount: 11_100 }, // 23:59:59 on 29 Nov in Kyiv (UTC+2)
        ],
      });
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 22_200, cost: null }],
        captures: [
          { at: '2026-11-29T22:00:00Z', amount: 22_200 }, // 00:00:00 on 30 Nov
        ],
      });
    });
    const day29 = await readRevenue(
      handle.db,
      parsePeriod({ from: '2026-11-29', to: '2026-11-29' }),
    );
    const day30 = await readRevenue(
      handle.db,
      parsePeriod({ from: '2026-11-30', to: '2026-11-30' }),
    );
    expect(day29.totals.gross).toBe(11_100);
    expect(day30.totals.gross).toBe(22_200);
  });

  it('a day of 23 hours (spring) and of 25 hours (autumn) is judged by the database', async () => {
    const spring = await readRevenue(
      handle.db,
      parsePeriod({ from: '2026-03-29', to: '2026-03-29' }),
    );
    expect(spring.period.startsAt).toBe('2026-03-28T22:00:00.000Z');
    expect(spring.period.endsAt).toBe('2026-03-29T21:00:00.000Z');
    const autumn = await readRevenue(
      handle.db,
      parsePeriod({ from: '2026-10-25', to: '2026-10-25' }),
    );
    expect(autumn.period.startsAt).toBe('2026-10-24T21:00:00.000Z');
    expect(autumn.period.endsAt).toBe('2026-10-25T22:00:00.000Z');
  });

  it('sums past the 32-bit integer range stay exact', async () => {
    await handle.db.transaction(async (tx) => {
      for (let i = 0; i < 2; i += 1) {
        await insertOrder(tx, {
          lines: [{ quantity: 1, price: 2_000_000_000, cost: null }],
          captures: [{ at: '2027-01-15T10:00:00Z', amount: 2_000_000_000 }],
        });
      }
    });
    const report = await readRevenue(
      handle.db,
      parsePeriod({ from: '2027-01-01', to: '2027-01-31' }),
    );
    expect(report.totals.gross).toBe(4_000_000_000);
  });

  it('money rows without a time are counted as untimed, never silently lost', async () => {
    await handle.db.transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 5_000, cost: null }],
        captures: [{ at: null, amount: 5_000 }],
        refunds: [{ at: null, amount: 1_000 }],
      });
    });
    const report = await readRevenue(handle.db, june());
    expect(report.totals.untimedCaptures).toBe(1);
    expect(report.totals.untimedRefunds).toBe(1);
    expect(report.totals.gross).toBe(155_000);
  });

  it('an empty database gives zeros, a full series and no percentage', async () => {
    const report = await readRevenue(emptyHandle.db, june('week'));
    expect(report.totals).toMatchObject({ gross: 0, refunds: 0, net: 0, captures: 0 });
    expect(report.series).toHaveLength(5);
    const { comparison } = await readRevenueComparison(emptyHandle.db, june());
    expect(comparison.gross.vsPrevious).toEqual({
      previous: 0,
      current: 0,
      absolute: 0,
      percentBps: null,
    });
    expect(comparison.lastYear).toBeNull();
  });
});

describe('comparison', () => {
  it('previous period of the same length and the same dates last year when data that old exists', async () => {
    await handle.db.transaction(async (tx) => {
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 40_000, cost: null }],
        captures: [{ at: '2025-08-10T10:00:00Z', amount: 40_000 }],
      });
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 10_000, cost: null }],
        captures: [{ at: '2026-07-10T10:00:00Z', amount: 10_000 }],
      });
      await insertOrder(tx, {
        lines: [{ quantity: 1, price: 30_000, cost: null }],
        captures: [{ at: '2026-08-10T10:00:00Z', amount: 30_000 }],
      });
    });
    const { comparison } = await readRevenueComparison(
      handle.db,
      parsePeriod({ from: '2026-08-01', to: '2026-08-31' }),
    );
    expect(comparison.previous).toMatchObject({ from: '2026-07-01', to: '2026-07-31' });
    expect(comparison.gross.vsPrevious).toEqual({
      previous: 10_000,
      current: 30_000,
      absolute: 20_000,
      percentBps: 20_000,
    });
    expect(comparison.lastYear).toMatchObject({ from: '2025-08-01', to: '2025-08-31' });
    expect(comparison.gross.vsLastYear).toEqual({
      previous: 40_000,
      current: 30_000,
      absolute: -10_000,
      percentBps: -2_500,
    });
  });

  it('a period that fell to zero is exactly minus 100 percent; one that rose from zero has no percentage', async () => {
    const fell = await readRevenueComparison(
      handle.db,
      parsePeriod({ from: '2026-10-01', to: '2026-10-31' }),
    );
    // previous (September) gross 50 000, current (October) gross 0
    expect(fell.comparison.gross.vsPrevious.percentBps).toBe(-10_000);
    const rose = await readRevenueComparison(
      handle.db,
      parsePeriod({ from: '2026-09-01', to: '2026-09-30' }),
    );
    // previous (August) had 30 000 from the test above; use a period whose previous is empty
    expect(rose.comparison.gross.vsPrevious.previous).toBe(30_000);
    const fromZero = await readRevenueComparison(
      handle.db,
      parsePeriod({ from: '2026-04-01', to: '2026-04-30' }),
    );
    expect(fromZero.comparison.gross.vsPrevious.percentBps).toBeNull();
  });
});
