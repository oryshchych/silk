/**
 * Manual stock changes on real Postgres: the number and its history always agree, the guard
 * against a negative result holds under parallel callers on separate connections, and a stocktake
 * below the reserved quantity is reported, not refused.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { productVariants, stockAdjustments } from '@store/db/schema';

import {
  adjustStock,
  InvalidStockChangeError,
  StockBelowZeroError,
  StockVariantNotFoundError,
} from '../src/stock/adjust-stock.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;
let variantId: string;

beforeAll(async () => {
  world = await createWorld();
  admin = world.connect(4);
  variantId = world.fixture.variantIds[0];
});
afterAll(async () => {
  await world.close();
});

const stockOf = async (id: string) =>
  (await admin.db.select().from(productVariants).where(eq(productVariants.id, id)))[0];
const historyOf = async (id: string) =>
  await admin.db.select().from(stockAdjustments).where(eq(stockAdjustments.variantId, id));
const setStock = async (id: string, quantity: number, reserved = 0) =>
  await admin.db.execute(
    sql`UPDATE product_variants SET stock_quantity = ${quantity}, reserved_quantity = ${reserved} WHERE id = ${id}::uuid`,
  );

describe('adjustStock', () => {
  it('a receipt adds, a write-off subtracts, and each leaves one history row that adds up', async () => {
    await setStock(variantId, 10);
    const received = await admin.db.transaction(
      async (tx) =>
        await adjustStock(tx, {
          variantId,
          change: { kind: 'delta', delta: 5 },
          reason: 'receipt',
          note: 'delivery 42',
          userId: null,
        }),
    );
    expect(received).toMatchObject({ before: 10, after: 15, changed: true });
    await admin.db.transaction(async (tx) => {
      await adjustStock(tx, {
        variantId,
        change: { kind: 'delta', delta: -3 },
        reason: 'writeoff',
        userId: null,
      });
    });
    expect((await stockOf(variantId))?.stockQuantity).toBe(12);
    const history = (await historyOf(variantId)).sort((a, b) => a.quantityAfter - b.quantityAfter);
    expect(history.map((h) => [h.reason, h.delta, h.quantityBefore, h.quantityAfter])).toEqual(
      [
        ['writeoff', -3, 15, 12],
        ['receipt', 5, 10, 15],
      ].sort((a, b) => (a[3] as number) - (b[3] as number)),
    );
    expect(history.find((h) => h.reason === 'receipt')?.note).toBe('delivery 42');
  });

  it('refuses to go below zero and changes nothing, history included', async () => {
    await setStock(variantId, 2);
    const before = (await historyOf(variantId)).length;
    await expect(
      admin.db.transaction(
        async (tx) =>
          await adjustStock(tx, {
            variantId,
            change: { kind: 'delta', delta: -3 },
            reason: 'writeoff',
            userId: null,
          }),
      ),
    ).rejects.toBeInstanceOf(StockBelowZeroError);
    expect((await stockOf(variantId))?.stockQuantity).toBe(2);
    expect((await historyOf(variantId)).length).toBe(before);
  });

  it('a stocktake sets the counted quantity; below the reserved quantity it is reported, not refused', async () => {
    await setStock(variantId, 8, 5);
    const result = await admin.db.transaction(
      async (tx) =>
        await adjustStock(tx, {
          variantId,
          change: { kind: 'set', quantity: 3 },
          reason: 'stocktake',
          userId: null,
        }),
    );
    expect(result).toMatchObject({ before: 8, after: 3, reserved: 5, belowReserved: true });
    expect((await stockOf(variantId))?.stockQuantity).toBe(3);
  });

  it('a stocktake to the current quantity changes nothing and writes no history', async () => {
    await setStock(variantId, 7);
    const before = (await historyOf(variantId)).length;
    const result = await admin.db.transaction(
      async (tx) =>
        await adjustStock(tx, {
          variantId,
          change: { kind: 'set', quantity: 7 },
          reason: 'stocktake',
          userId: null,
        }),
    );
    expect(result.changed).toBe(false);
    expect((await historyOf(variantId)).length).toBe(before);
  });

  it('rejects a zero or fractional delta, a negative or huge quantity, and an unknown variant', async () => {
    const run = async (change: Parameters<typeof adjustStock>[1]['change'], id = variantId) =>
      await admin.db.transaction(
        async (tx) =>
          await adjustStock(tx, { variantId: id, change, reason: 'correction', userId: null }),
      );
    for (const change of [
      { kind: 'delta', delta: 0 },
      { kind: 'delta', delta: 1.5 },
      { kind: 'delta', delta: 2_000_000 },
      { kind: 'set', quantity: -1 },
      { kind: 'set', quantity: 0.5 },
      { kind: 'set', quantity: 5_000_000 },
    ] as const) {
      await expect(run(change), JSON.stringify(change)).rejects.toBeInstanceOf(
        InvalidStockChangeError,
      );
    }
    await expect(
      run({ kind: 'delta', delta: 1 }, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(StockVariantNotFoundError);
  });

  it('twelve parallel write-offs of one unit on separate connections against stock 5: exactly five succeed', async () => {
    await setStock(variantId, 5);
    const before = (await historyOf(variantId)).length;
    const barrier = new Barrier(12);
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const other = world.connect(1);
        await barrier.wait();
        return await other.db
          .transaction(
            async (tx) =>
              await adjustStock(tx, {
                variantId,
                change: { kind: 'delta', delta: -1 },
                reason: 'writeoff',
                userId: null,
              }),
          )
          .then(() => 'ok' as const)
          .catch((error: unknown) => (error instanceof StockBelowZeroError ? 'refused' : 'broken'));
      }),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(7);
    expect((await stockOf(variantId))?.stockQuantity).toBe(0);
    expect((await historyOf(variantId)).length - before).toBe(5);
  });

  it('parallel receipts and stocktakes keep the history consistent with the number', async () => {
    await setStock(variantId, 0);
    const startRows = (await historyOf(variantId)).length;
    const barrier = new Barrier(10);
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const other = world.connect(1);
        await barrier.wait();
        await other.db.transaction(async (tx) => {
          await adjustStock(tx, {
            variantId,
            change: i % 5 === 0 ? { kind: 'set', quantity: 100 + i } : { kind: 'delta', delta: 2 },
            reason: i % 5 === 0 ? 'stocktake' : 'receipt',
            userId: null,
          });
        });
      }),
    );
    const final = (await stockOf(variantId))?.stockQuantity ?? -1;
    const rows = (await historyOf(variantId)).filter(
      (row) => row.reason === 'receipt' || row.reason === 'stocktake',
    );
    // Every change since the start is in the history, and the deltas add up to the stored number.
    const since = (await historyOf(variantId)).length - startRows;
    expect(since).toBeGreaterThanOrEqual(8);
    const total = (await historyOf(variantId))
      .sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1))
      .slice(-since)
      .reduce((sum, row) => sum + row.delta, 0);
    expect(total).toBe(final);
    expect(rows.length).toBeGreaterThan(0);
  });
});
