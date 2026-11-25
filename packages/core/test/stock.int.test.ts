/**
 * Manual stock changes on real Postgres: the number and its history always agree, the guard
 * against a negative result holds under parallel callers on separate connections, and a stocktake
 * below the reserved quantity is REFUSED (queue Q44), a retried request id changes nothing once.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { auditLog, productVariants, stockAdjustments } from '@store/db/schema';

import {
  adjustStock,
  InvalidStockChangeError,
  StockAboveMaxError,
  StockBelowReservedError,
  StockBelowZeroError,
  StockRequestReusedError,
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

  it('a write-off that would leave less than is reserved is refused: nothing changes, no history', async () => {
    await setStock(variantId, 10, 8);
    const before = (await historyOf(variantId)).length;
    await expect(
      admin.db.transaction(
        async (tx) =>
          await adjustStock(tx, {
            variantId,
            change: { kind: 'delta', delta: -5 },
            reason: 'writeoff',
            userId: null,
          }),
      ),
    ).rejects.toBeInstanceOf(StockBelowReservedError);
    expect(await stockOf(variantId)).toMatchObject({ stockQuantity: 10, reservedQuantity: 8 });
    expect((await historyOf(variantId)).length).toBe(before);
    // Down to exactly the reserved quantity is fine.
    await admin.db.transaction(async (tx) => {
      await adjustStock(tx, {
        variantId,
        change: { kind: 'delta', delta: -2 },
        reason: 'writeoff',
        userId: null,
      });
    });
    expect((await stockOf(variantId))?.stockQuantity).toBe(8);
  });

  it('a stocktake below the reserved quantity is refused too; at the reserved quantity it is accepted', async () => {
    await setStock(variantId, 8, 5);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await adjustStock(tx, {
            variantId,
            change: { kind: 'set', quantity: 3 },
            reason: 'stocktake',
            userId: null,
          }),
      ),
    ).rejects.toBeInstanceOf(StockBelowReservedError);
    expect((await stockOf(variantId))?.stockQuantity).toBe(8);
    const ok = await admin.db.transaction(
      async (tx) =>
        await adjustStock(tx, {
          variantId,
          change: { kind: 'set', quantity: 5 },
          reason: 'stocktake',
          userId: null,
        }),
    );
    expect(ok).toMatchObject({ before: 8, after: 5, reserved: 5 });
  });

  it('an increase releases nothing and leaves the reserved quantity as it is', async () => {
    await setStock(variantId, 4, 4);
    await admin.db.transaction(async (tx) => {
      await adjustStock(tx, {
        variantId,
        change: { kind: 'delta', delta: 6 },
        reason: 'receipt',
        userId: null,
      });
    });
    expect(await stockOf(variantId)).toMatchObject({ stockQuantity: 10, reservedQuantity: 4 });
  });

  it('the stock cannot be pushed past the maximum by repeated receipts', async () => {
    await setStock(variantId, 999_999);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await adjustStock(tx, {
            variantId,
            change: { kind: 'delta', delta: 5 },
            reason: 'receipt',
            userId: null,
          }),
      ),
    ).rejects.toBeInstanceOf(StockAboveMaxError);
    expect((await stockOf(variantId))?.stockQuantity).toBe(999_999);
  });

  it('the same request id twice changes the stock once and returns the first result', async () => {
    await setStock(variantId, 10);
    const requestId = '3f2a9c10-7d3e-4a55-9b1e-0c2d4e6f8a01';
    const call = async () =>
      await admin.db.transaction(
        async (tx) =>
          await adjustStock(tx, {
            variantId,
            change: { kind: 'delta', delta: 5 },
            reason: 'receipt',
            userId: null,
            requestId,
          }),
      );
    const first = await call();
    const second = await call();
    expect(first).toMatchObject({ before: 10, after: 15, replayed: false, changed: true });
    expect(second).toMatchObject({ before: 10, after: 15, replayed: true, changed: false });
    expect((await stockOf(variantId))?.stockQuantity).toBe(15);
    expect((await historyOf(variantId)).filter((h) => h.requestId === requestId)).toHaveLength(1);
  });

  it('two parallel submissions of one request id on separate connections apply once', async () => {
    await setStock(variantId, 0);
    const requestId = '9d1b7e22-4c6f-4b8a-8e0d-5a7c3b1f2e02';
    const barrier = new Barrier(2);
    const results = await Promise.all(
      [0, 1].map(async () => {
        const other = world.connect(1);
        await barrier.wait();
        return await other.db.transaction(
          async (tx) =>
            await adjustStock(tx, {
              variantId,
              change: { kind: 'delta', delta: 7 },
              reason: 'receipt',
              userId: null,
              requestId,
            }),
        );
      }),
    );
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    expect((await stockOf(variantId))?.stockQuantity).toBe(7);
  });

  it('one request id on ANOTHER variant is an error, not a silent replay', async () => {
    const other = world.fixture.variantIds[1];
    await setStock(variantId, 5);
    await setStock(other, 5);
    const requestId = 'c4e8a1b3-2f6d-4d90-a7b5-1e3f5a7c9b03';
    await admin.db.transaction(async (tx) => {
      await adjustStock(tx, {
        variantId,
        change: { kind: 'delta', delta: 1 },
        reason: 'receipt',
        userId: null,
        requestId,
      });
    });
    await expect(
      admin.db.transaction(
        async (tx) =>
          await adjustStock(tx, {
            variantId: other,
            change: { kind: 'delta', delta: 1 },
            reason: 'receipt',
            userId: null,
            requestId,
          }),
      ),
    ).rejects.toBeInstanceOf(StockRequestReusedError);
  });

  it('the result carries the audit draft, and the change, the history and the audit row roll back together', async () => {
    await setStock(variantId, 10);
    const historyBefore = (await historyOf(variantId)).length;
    const auditBefore = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log`,
    );
    await expect(
      admin.db.transaction(async (tx) => {
        const result = await adjustStock(tx, {
          variantId,
          change: { kind: 'delta', delta: 3 },
          reason: 'receipt',
          userId: null,
        });
        expect(result.audit).toEqual({
          action: 'update',
          entity: 'product_variant',
          entityId: variantId,
          diff: { stock: { from: 10, to: 13 }, reason: 'receipt' },
        });
        await tx.insert(auditLog).values({ userId: null, ...result.audit });
        throw new Error('abort after everything was written');
      }),
    ).rejects.toThrow('abort');
    expect((await stockOf(variantId))?.stockQuantity).toBe(10);
    expect((await historyOf(variantId)).length).toBe(historyBefore);
    const auditAfter = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log`,
    );
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n);
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
