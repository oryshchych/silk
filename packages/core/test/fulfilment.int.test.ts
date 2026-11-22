/**
 * Ship and cancel on real Postgres, separate connections and barriers
 * (phase 0.5 criteria 10, 11 and 13). The stock invariant checked after every
 * scenario is the one `stock:reconcile` will check in production:
 * reserved_quantity equals the sum of the live reservations.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import {
  InsufficientStockError,
  OrderNotCancellableError,
  OrderNotShippableError,
  StockDriftError,
} from '../src/errors.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { cancelOrder, shipOrder } from '../src/orders/fulfilment.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;
let v1: string;
let v2: string;
let seq = 0;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  [v1, v2] = world.fixture.variantIds;
});

afterEach(async () => {
  await world.close();
});

async function place(variantId: string, promoCode: string | null = null): Promise<string> {
  return await placeMany([variantId], promoCode);
}

async function placeMany(variantIds: string[], promoCode: string | null = null): Promise<string> {
  seq += 1;
  const token = `tok-fulfilment-${String(seq)}`.padEnd(20, 'x');
  for (const variantId of variantIds) {
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, { cartToken: token, variantId, quantity: 1 });
    });
  }
  const view = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await admin.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: view.intentId,
        ownerToken: token,
        contact: { email: 'b@example.com', phone: '+380501112233', name: 'Buyer' },
        delivery: { method: 'pickup' },
        paymentProvider: 'mono',
        promoCode,
        locale: 'uk',
      }),
  );
  return placed.orderId;
}

/** Test setup only: the webhook flow that really does this is covered in webhook.int.test.ts. */
async function markPaid(orderId: string): Promise<void> {
  await admin.db.execute(
    sql`UPDATE orders SET payment_status = 'paid', captured_total = total, paid_at = now()
         WHERE id = ${orderId}`,
  );
  await admin.db.execute(
    sql`UPDATE stock_reservations SET expires_at = NULL WHERE order_id = ${orderId}`,
  );
}

async function stock(variantId: string) {
  const result = await admin.db.execute<{ stock: number; reserved: number }>(
    sql`SELECT stock_quantity AS stock, reserved_quantity AS reserved
          FROM product_variants WHERE id = ${variantId}`,
  );
  return result.rows[0];
}

async function statusOf(orderId: string): Promise<string | undefined> {
  const result = await admin.db.execute<{ status: string }>(
    sql`SELECT status FROM orders WHERE id = ${orderId}`,
  );
  return result.rows[0]?.status;
}

async function countOf(table: string, where = sql`true`): Promise<number> {
  const result = await admin.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${where}`,
  );
  return result.rows[0]?.n ?? -1;
}

/** The stock:reconcile check: the denormalised counter equals the live reservations. */
async function assertStockInvariant(): Promise<void> {
  const drift = await admin.db.execute<{ id: string }>(
    sql`SELECT v.id FROM product_variants v
         WHERE v.reserved_quantity <> coalesce(
           (SELECT sum(r.quantity) FROM stock_reservations r
             WHERE r.variant_id = v.id AND r.released_at IS NULL), 0)`,
  );
  expect(drift.rows).toEqual([]);
}

const ship = async (orderId: string, handle: DbHandle = world.connect()) =>
  await handle.db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 'test:admin' }));
const cancel = async (orderId: string, handle: DbHandle = world.connect()) =>
  await handle.db.transaction(
    async (tx) => await cancelOrder(tx, { orderId, source: 'test:admin', reason: 'test' }),
  );

/** Runs `op` in a transaction and keeps it OPEN until `release()`: a proof of overlap, not a guess. */
async function held<T>(
  op: (tx: Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0]) => Promise<T>,
) {
  const handle = world.connect();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = handle.db.transaction(async (tx) => {
    const result = await op(tx);
    ready();
    await gate;
    return result;
  });
  done.catch(() => {
    ready();
  });
  await started;
  return { release, done };
}

async function waitUntilBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('nothing ever blocked on a lock: the operations did not overlap');
}

/** Row counts and stock numbers of everything ship and cancel may touch. */
async function snapshot(): Promise<unknown> {
  const result = await admin.db.execute(
    sql`SELECT
          (SELECT string_agg(status::text, ',' ORDER BY id) FROM orders) AS statuses,
          (SELECT count(*) FROM stock_reservations WHERE released_at IS NULL) AS live,
          (SELECT string_agg(stock_quantity || '/' || reserved_quantity, ',' ORDER BY id) FROM product_variants) AS stock,
          (SELECT count(*) FROM order_status_history) AS history,
          (SELECT count(*) FROM audit_log) AS audit,
          (SELECT count(*) FROM outbox) AS outbox,
          (SELECT coalesce(sum(uses_count), 0) FROM promo_codes) AS promo,
          (SELECT count(*) FROM promo_code_redemptions WHERE state = 'consumed') AS redemptions`,
  );
  return result.rows[0];
}

describe('criterion 10: paid does not reduce stock, shipped reduces it exactly once', () => {
  it('payment leaves stock alone; shipping moves stock and reserved together', async () => {
    const orderId = await place(v1);
    await markPaid(orderId);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 }); // paid: nothing moved

    expect(await ship(orderId)).toMatchObject({ changed: true });
    expect(await stock(v1)).toEqual({ stock: 0, reserved: 0 });
    expect(await statusOf(orderId)).toBe('shipped');
    expect(await countOf('stock_reservations', sql`release_reason = 'shipped'`)).toBe(1);
    expect(
      await countOf('order_status_history', sql`field = 'status' AND to_status = 'shipped'`),
    ).toBe(1);
    await assertStockInvariant();
  });

  it('five concurrent ships deduct once', async () => {
    const orderId = await place(v1);
    await markPaid(orderId);
    const barrier = new Barrier(5);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await ship(orderId, handle);
      }),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await stock(v1)).toEqual({ stock: 0, reserved: 0 });
    expect(await countOf('order_status_history', sql`to_status = 'shipped'`)).toBe(1);
    await assertStockInvariant();
  });

  it('an unpaid order, a cancelled order and an order without a live reservation do not ship', async () => {
    const unpaid = await place(v1);
    await expect(ship(unpaid)).rejects.toBeInstanceOf(OrderNotShippableError);

    await markPaid(unpaid);
    await admin.db.execute(
      sql`UPDATE stock_reservations SET released_at = now(), release_reason = 'expired'`,
    );
    await admin.db.execute(sql`UPDATE product_variants SET reserved_quantity = 0 WHERE id = ${v1}`);
    await expect(ship(unpaid)).rejects.toThrow(/no live reservation/);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 }); // nothing moved

    const other = await place(v2);
    await markPaid(other);
    await cancel(other);
    await expect(ship(other)).rejects.toThrow(/cancelled/);
  });
});

describe('criterion 11: cancelling after paid', () => {
  it('closes the reservation and leaves stock_quantity unchanged; the refund is announced once', async () => {
    const orderId = await place(v1);
    await markPaid(orderId);
    expect(await cancel(orderId)).toMatchObject({ changed: true });

    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 }); // the goods never left the shelf
    expect(await statusOf(orderId)).toBe('cancelled');
    // cancelling does not rewrite the money: the payment stays paid and the capture stays put
    const money = await admin.db.execute<{
      payment_status: string;
      captured_total: number;
      total: number;
    }>(sql`SELECT payment_status, captured_total, total FROM orders WHERE id = ${orderId}`);
    expect(money.rows[0]).toMatchObject({ payment_status: 'paid' });
    expect(money.rows[0]?.captured_total).toBe(money.rows[0]?.total);
    expect(await countOf('stock_reservations', sql`release_reason = 'cancelled'`)).toBe(1);
    expect(await countOf('outbox', sql`topic = 'alert.refund-due'`)).toBe(1);
    expect(await cancel(orderId)).toMatchObject({ changed: false });
    expect(await countOf('outbox', sql`topic = 'alert.refund-due'`)).toBe(1);
    await assertStockInvariant();
  });

  it('an unpaid cancel closes open attempts and announces no refund', async () => {
    const orderId = await place(v1);
    await admin.db.execute(
      sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount)
          SELECT id, 1, 'mono', total FROM orders WHERE id = ${orderId}`,
    );
    await cancel(orderId);
    expect(await countOf('payment_attempts', sql`failure_reason = 'order cancelled'`)).toBe(1);
    expect(await countOf('outbox', sql`topic = 'alert.refund-due'`)).toBe(0);
  });

  it('five concurrent cancels release once (the counter never goes negative)', async () => {
    const orderId = await place(v1);
    const barrier = new Barrier(5);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await cancel(orderId, handle);
      }),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });
    await assertStockInvariant();
  });

  it('a shipped order cannot be cancelled', async () => {
    const orderId = await place(v1);
    await markPaid(orderId);
    await ship(orderId);
    await expect(cancel(orderId)).rejects.toBeInstanceOf(OrderNotCancellableError);
    expect(await stock(v1)).toEqual({ stock: 0, reserved: 0 });
  });

  it('cancel releases the promo use exactly once', async () => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value, max_uses) VALUES ('ONCE', 'fixed', 100, 1)`,
    );
    const orderId = await place(v1, 'ONCE');
    expect(await countOf('promo_codes', sql`uses_count = 1`)).toBe(1);
    await cancel(orderId);
    await cancel(orderId);
    expect(await countOf('promo_codes', sql`uses_count = 0`)).toBe(1);
    expect(await countOf('promo_code_redemptions', sql`state = 'released'`)).toBe(1);
    // the use is free again: another checkout can take it
    const again = await place(v2, 'ONCE');
    expect(await statusOf(again)).toBe('pending');
  });

  it('ship and cancel racing on one paid order: exactly one wins, stock stays consistent', async () => {
    for (let round = 0; round < 6; round += 1) {
      const orderId = await place(v1);
      await markPaid(orderId);
      const barrier = new Barrier(2);
      const run = async (op: 'ship' | 'cancel') => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return op === 'ship' ? await ship(orderId, handle) : await cancel(orderId, handle);
      };
      const results = await Promise.allSettled([run('ship'), run('cancel')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const status = await statusOf(orderId);
      const expected = status === 'shipped' ? { stock: 0, reserved: 0 } : { stock: 1, reserved: 0 };
      expect(await stock(v1)).toEqual(expected);
      await assertStockInvariant();
      // restock for the next round
      await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 1 WHERE id = ${v1}`);
    }
  });
});

describe('criterion 13: cancelling an order while a new one is being created', () => {
  const isDeadlock = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    if ('code' in error && error.code === '40P01') return true;
    return 'cause' in error && isDeadlock(error.cause);
  };

  it('no deadlock over 12 overlapping rounds sharing the variant and the promo code', async () => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value) VALUES ('SHARED', 'fixed', 100)`,
    );
    for (let round = 0; round < 12; round += 1) {
      const old = await place(v1, 'SHARED');

      seq += 1;
      const token = `tok-new-checkout-${String(seq)}`.padEnd(20, 'x');
      await admin.db.transaction(async (tx) => {
        await setCartItem(tx, { cartToken: token, variantId: v1, quantity: 1 });
      });
      const view = await admin.db.transaction(
        async (tx) => await startCheckout(tx, { cartToken: token }),
      );

      const barrier = new Barrier(2);
      const cancelling = (async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await cancel(old, handle);
      })();
      const checkingOut = (async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await handle.db.transaction(
          async (tx) =>
            await createOrder(tx, {
              intentId: view.intentId,
              ownerToken: token,
              contact: { email: 'n@example.com', phone: '+380501112244', name: 'New' },
              delivery: { method: 'pickup' },
              paymentProvider: 'mono',
              promoCode: 'SHARED',
              locale: 'uk',
            }),
        );
      })();

      const results = await Promise.allSettled([cancelling, checkingOut]);
      expect(
        results.filter((r) => r.status === 'rejected' && isDeadlock(r.reason)),
        `round ${String(round)}`,
      ).toHaveLength(0);
      // the cancel always succeeds; the new checkout either got the freed unit or was told "no stock"
      expect(results[0].status).toBe('fulfilled');
      await assertStockInvariant();
      // clean up for the next round
      await admin.db.execute(
        sql`UPDATE stock_reservations SET released_at = now(), release_reason = 'cancelled' WHERE released_at IS NULL`,
      );
      await admin.db.execute(sql`UPDATE product_variants SET reserved_quantity = 0`);
      await admin.db.execute(sql`UPDATE promo_codes SET uses_count = 0`);
    }
  });
});

describe('review round: proven overlap, guards and rollback', () => {
  it('ship waits for a held cancel, then refuses; cancel waits for a held ship, then refuses', async () => {
    const first = await place(v1);
    await markPaid(first);
    const cancelling = await held((tx) =>
      cancelOrder(tx, { orderId: first, source: 't', reason: null }),
    );
    const shipAttempt = ship(first).catch((e: unknown) => e);
    await waitUntilBlocked();
    cancelling.release();
    await cancelling.done;
    expect(await shipAttempt).toBeInstanceOf(OrderNotShippableError);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });

    const second = await place(v1);
    await markPaid(second);
    const shipping = await held((tx) => shipOrder(tx, { orderId: second, source: 't' }));
    const cancelAttempt = cancel(second).catch((e: unknown) => e);
    await waitUntilBlocked();
    shipping.release();
    await shipping.done;
    expect(await cancelAttempt).toBeInstanceOf(OrderNotCancellableError);
    expect(await stock(v1)).toEqual({ stock: 0, reserved: 0 });
    await assertStockInvariant();
  });

  it('a checkout waits for a held cancel of the order that holds the last unit, then gets it', async () => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value) VALUES ('SHARED', 'fixed', 100)`,
    );
    const old = await place(v1, 'SHARED');
    seq += 1;
    const token = `tok-waiting-checkout-${String(seq)}`.padEnd(24, 'x');
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, { cartToken: token, variantId: v1, quantity: 1 });
    });
    const view = await admin.db.transaction(
      async (tx) => await startCheckout(tx, { cartToken: token }),
    );

    const cancelling = await held((tx) =>
      cancelOrder(tx, { orderId: old, source: 't', reason: null }),
    );
    const checkout = world
      .connect()
      .db.transaction(
        async (tx) =>
          await createOrder(tx, {
            intentId: view.intentId,
            ownerToken: token,
            contact: { email: 'n@example.com', phone: '+380501112244', name: 'New' },
            delivery: { method: 'pickup' },
            paymentProvider: 'mono',
            promoCode: 'SHARED',
            locale: 'uk',
          }),
      )
      .catch((e: unknown) => e);
    await waitUntilBlocked(); // the checkout really queued behind the cancel
    cancelling.release();
    await cancelling.done;
    expect(await checkout).toMatchObject({ created: true }); // it received the freed unit
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 });
    await assertStockInvariant();
  });

  it.each([
    ['not paid yet', sql`payment_status = 'authorized'`],
    ['partially refunded', sql`payment_status = 'partially_refunded'`],
    ['captured less than the total', sql`captured_total = total - 1`],
  ])('an order that is %s does not ship', async (_name, change) => {
    const orderId = await place(v1);
    await markPaid(orderId);
    await admin.db.execute(sql`UPDATE orders SET ${change} WHERE id = ${orderId}`);
    await expect(ship(orderId)).rejects.toBeInstanceOf(OrderNotShippableError);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 });
  });

  it('live reservations that do not match the order items block shipping', async () => {
    const orderId = await placeMany([v1, v2]);
    await markPaid(orderId);
    await admin.db.execute(
      sql`UPDATE stock_reservations SET released_at = now(), release_reason = 'cancelled' WHERE variant_id = ${v2}`,
    );
    await admin.db.execute(sql`UPDATE product_variants SET reserved_quantity = 0 WHERE id = ${v2}`);
    await expect(ship(orderId)).rejects.toThrow(/do not match/);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 });
  });

  it('a multi-variant order ships and cancels consistently', async () => {
    const shipped = await placeMany([v1, v2]);
    await markPaid(shipped);
    await ship(shipped);
    expect(await stock(v1)).toEqual({ stock: 0, reserved: 0 });
    expect(await stock(v2)).toEqual({ stock: 0, reserved: 0 });
    await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 1`);
    const cancelled = await placeMany([v2, v1]);
    await cancel(cancelled);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });
    expect(await stock(v2)).toEqual({ stock: 1, reserved: 0 });
    await assertStockInvariant();
  });

  it.each(['confirmed', 'processing'])('cancel works from %s', async (status) => {
    const orderId = await place(v1);
    await admin.db.execute(
      sql`UPDATE orders SET status = ${status}::order_status WHERE id = ${orderId}`,
    );
    expect(await cancel(orderId)).toMatchObject({ changed: true });
    expect(await statusOf(orderId)).toBe('cancelled');
  });

  it('cancelling with a card hold open closes the attempt and raises the refund alert', async () => {
    const orderId = await place(v1);
    await admin.db.execute(
      sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status)
          SELECT id, 1, 'mono', total, 'in_flight', 'authorized' FROM orders WHERE id = ${orderId}`,
    );
    await cancel(orderId);
    expect(await countOf('payment_attempts', sql`failure_reason = 'order cancelled'`)).toBe(1);
    const alert = await admin.db.execute<{ payload: { heldAuthorization: boolean } }>(
      sql`SELECT payload FROM outbox WHERE topic = 'alert.refund-due'`,
    );
    expect(alert.rows[0]?.payload.heldAuthorization).toBe(true);
  });

  it('the refund alert is the NET amount: nothing left to refund means no alert', async () => {
    const full = await place(v1);
    await markPaid(full);
    await admin.db.execute(
      sql`UPDATE orders SET refunded_total = captured_total WHERE id = ${full}`,
    );
    await cancel(full);
    expect(await countOf('outbox', sql`topic = 'alert.refund-due'`)).toBe(0);

    const partial = await place(v2);
    await markPaid(partial);
    await admin.db.execute(sql`UPDATE orders SET refunded_total = 1000 WHERE id = ${partial}`);
    await cancel(partial);
    const alert = await admin.db.execute<{ payload: { refundable: number } }>(
      sql`SELECT payload FROM outbox WHERE topic = 'alert.refund-due'`,
    );
    expect(alert.rows[0]?.payload.refundable).toBe(129900 - 1000);
  });

  it('counter drift is a typed error and rolls everything back', async () => {
    const orderId = await place(v1);
    await admin.db.execute(sql`UPDATE product_variants SET reserved_quantity = 0 WHERE id = ${v1}`);
    const before = await snapshot();
    const error = await cancel(orderId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StockDriftError);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['ship', 'cancel'] as const)(
    'a failure right after %s rolls back every table it touched',
    async (operation) => {
      await admin.db.execute(
        sql`INSERT INTO promo_codes (code, type, value) VALUES ('ROLL', 'fixed', 100)`,
      );
      const orderId = await place(v1, 'ROLL');
      await markPaid(orderId);
      const before = await snapshot();
      await expect(
        world.connect().db.transaction(async (tx) => {
          if (operation === 'ship') await shipOrder(tx, { orderId, source: 't' });
          else await cancelOrder(tx, { orderId, source: 't', reason: null });
          throw new Error('crash after the last step');
        }),
      ).rejects.toThrow('crash');
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe('review round 2: transitions, ship drift, ship against a checkout', () => {
  it.each([
    ['delivered', 'cancel'],
    ['returned', 'ship'],
    ['returned', 'cancel'],
  ] as const)('an order that is %s refuses %s (not a silent no-op)', async (status, operation) => {
    const orderId = await place(v1);
    await markPaid(orderId);
    await admin.db.execute(
      sql`UPDATE orders SET status = ${status}::order_status WHERE id = ${orderId}`,
    );
    const attempt = operation === 'ship' ? ship(orderId) : cancel(orderId);
    await expect(attempt).rejects.toThrow(new RegExp(status));
  });

  it.each([
    ['reserved_quantity = 0', sql`reserved_quantity = 0`],
    ['stock_quantity = 0', sql`stock_quantity = 0`],
  ])(
    'ship with drifted counters (%s) is a StockDriftError and changes nothing',
    async (_name, change) => {
      const orderId = await place(v1);
      await markPaid(orderId);
      await admin.db.execute(sql`UPDATE product_variants SET ${change} WHERE id = ${v1}`);
      const before = await snapshot();
      const error = await ship(orderId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StockDriftError);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('a checkout queued behind a held ship finds the unit gone: told "no stock", never oversold', async () => {
    const paid = await place(v1);
    await markPaid(paid);
    seq += 1;
    const token = `tok-behind-ship-${String(seq)}`.padEnd(24, 'x');
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, { cartToken: token, variantId: v1, quantity: 1 });
    });
    const view = await admin.db.transaction(
      async (tx) => await startCheckout(tx, { cartToken: token }),
    );

    const shipping = await held((tx) => shipOrder(tx, { orderId: paid, source: 't' }));
    const checkout = world
      .connect()
      .db.transaction(
        async (tx) =>
          await createOrder(tx, {
            intentId: view.intentId,
            ownerToken: token,
            contact: { email: 'n@example.com', phone: '+380501112244', name: 'New' },
            delivery: { method: 'pickup' },
            paymentProvider: 'mono',
            promoCode: null,
            locale: 'uk',
          }),
      )
      .catch((e: unknown) => e);
    await waitUntilBlocked();
    shipping.release();
    await shipping.done;
    expect(await checkout).toBeInstanceOf(InsufficientStockError);
    expect(await stock(v1)).toEqual({ stock: 0, reserved: 0 });
    await assertStockInvariant();
  });
});
