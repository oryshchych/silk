/**
 * Editing the composition of an order (phase 5): totals, reservation and stock semantics (ADR-18),
 * refusals, replay, rollback and races, on real Postgres with separate connections.
 */
import { sql } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import {
  InsufficientStockError,
  OrderNotShippableError,
  OrderPaymentOpenError,
  OrderTransitionError,
} from '../src/errors.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { cancelOrder, shipOrder } from '../src/orders/fulfilment.ts';
import { editOrderItems } from '../src/orders-admin/edit-items.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const USER = '00000000-0000-4000-8000-0000000000aa';
let world: TestWorld;
let admin: DbHandle;
let v1: string;
let v2: string;
let seq = 0;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  [v1, v2] = world.fixture.variantIds;
  await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 10`);
});
afterEach(async () => {
  await world.close();
});

async function place(lines: [string, number][]): Promise<string> {
  seq += 1;
  const token = `tok-orders-edit-${String(seq)}`.padEnd(20, 'x');
  for (const [variantId, quantity] of lines) {
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, { cartToken: token, variantId, quantity });
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
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  return placed.orderId;
}

async function rows<T extends QueryResultRow>(query: ReturnType<typeof sql>) {
  return (await admin.db.execute<T>(query)).rows;
}
const itemsOf = async (orderId: string) =>
  await rows<{ id: string; variant: string; qty: number; total: number }>(
    sql`SELECT id, variant_id AS variant, quantity AS qty, line_total AS total FROM order_items WHERE order_id = ${orderId} ORDER BY id`,
  );
const stockOf = async (variantId: string) =>
  (
    await rows<{ s: number; r: number }>(
      sql`SELECT stock_quantity AS s, reserved_quantity AS r FROM product_variants WHERE id = ${variantId}`,
    )
  )[0];
const orderRow = async (orderId: string) =>
  (
    await rows<{ subtotal: number; discount: number; total: number; captured: number }>(
      sql`SELECT subtotal, discount_total AS discount, total, captured_total AS captured FROM orders WHERE id = ${orderId}`,
    )
  )[0];
const historyEdits = async (orderId: string) =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM order_status_history WHERE order_id = ${orderId} AND field = 'items'`,
    )
  )[0]?.n;
async function markPaid(orderId: string) {
  await admin.db.execute(
    sql`UPDATE orders SET payment_status = 'paid', captured_total = total, paid_at = now() WHERE id = ${orderId}`,
  );
  await admin.db.execute(
    sql`UPDATE stock_reservations SET expires_at = NULL WHERE order_id = ${orderId}`,
  );
}
const edit = (orderId: string, changes: { itemId: string; quantity: number }[], h = admin) =>
  h.db.transaction(
    async (tx) =>
      await editOrderItems(tx, { orderId, changes, reason: 'customer asked', actorUserId: USER }),
  );
async function drift() {
  return await rows(
    sql`SELECT v.id FROM product_variants v WHERE v.reserved_quantity <> coalesce((SELECT sum(r.quantity) FROM stock_reservations r WHERE r.variant_id = v.id AND r.released_at IS NULL), 0)`,
  );
}

describe('editing quantities and lines', () => {
  it('a smaller quantity recalculates the totals and releases reservation, not stock', async () => {
    const orderId = await place([[v1, 3]]);
    const [item] = await itemsOf(orderId);
    const before = await orderRow(orderId);
    const result = await edit(orderId, [{ itemId: item?.id ?? '', quantity: 1 }]);
    expect(result).toMatchObject({ changed: true, totalFrom: before?.total });
    const after = await orderRow(orderId);
    expect(after?.subtotal).toBe(129_900);
    expect(after?.total).toBe((before?.total ?? 0) - 2 * 129_900);
    expect(await stockOf(v1)).toEqual({ s: 10, r: 1 });
    expect(await historyEdits(orderId)).toBe(1);
    expect(await drift()).toEqual([]);
  });

  it('a line discount follows the quantity (prorated once, half-up) and the order maths holds', async () => {
    const orderId = await place([[v1, 3]]);
    const [item] = await itemsOf(orderId);
    // A discount of 1000 on a line of 3: the order's own CHECK must keep holding after the edit.
    await admin.db.execute(
      sql`UPDATE order_items SET line_discount = 1000, line_total = unit_price * 3 - 1000 WHERE order_id = ${orderId}`,
    );
    await admin.db.execute(
      sql`UPDATE orders SET discount_total = 1000, total = subtotal - 1000 + shipping_total + adjustment_total WHERE id = ${orderId}`,
    );
    await edit(orderId, [{ itemId: item?.id ?? '', quantity: 2 }]);
    const after = await orderRow(orderId);
    expect(after).toMatchObject({ subtotal: 259_800, discount: 667 });
    expect((await itemsOf(orderId))[0]?.total).toBe(259_800 - 667);
  });

  it('a larger quantity takes more stock atomically; beyond the stock it is refused and nothing moves', async () => {
    const orderId = await place([[v1, 1]]);
    const [item] = await itemsOf(orderId);
    await edit(orderId, [{ itemId: item?.id ?? '', quantity: 4 }]);
    expect(await stockOf(v1)).toEqual({ s: 10, r: 4 });
    const historyBefore = await historyEdits(orderId);
    await expect(edit(orderId, [{ itemId: item?.id ?? '', quantity: 11 }])).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
    expect(await stockOf(v1)).toEqual({ s: 10, r: 4 });
    expect((await itemsOf(orderId))[0]?.qty).toBe(4);
    expect(await historyEdits(orderId)).toBe(historyBefore);
  });

  it('taking a line off closes its reservation; the last line cannot be removed', async () => {
    const orderId = await place([
      [v1, 1],
      [v2, 2],
    ]);
    const items = await itemsOf(orderId);
    const second = items.find((i) => i.variant === v2);
    const first = items.find((i) => i.variant === v1);
    await edit(orderId, [{ itemId: second?.id ?? '', quantity: 0 }]);
    expect(await stockOf(v2)).toEqual({ s: 10, r: 0 });
    expect((await itemsOf(orderId)).map((i) => i.variant)).toEqual([v1]);
    expect(
      await rows(
        sql`SELECT 1 FROM stock_reservations WHERE order_id = ${orderId} AND variant_id = ${v2} AND release_reason = 'cancelled' AND released_at IS NOT NULL`,
      ),
    ).toHaveLength(1);
    await expect(edit(orderId, [{ itemId: first?.id ?? '', quantity: 0 }])).rejects.toBeInstanceOf(
      OrderTransitionError,
    );
    expect(await stockOf(v1)).toEqual({ s: 10, r: 1 });
    expect(await drift()).toEqual([]);
  });

  it('refuses a shipped order, a cancelled one, a receipt that exists, a foreign or repeated line, a bad quantity', async () => {
    const orderId = await place([[v1, 2]]);
    const [item] = await itemsOf(orderId);
    const id = item?.id ?? '';
    await expect(
      edit(orderId, [{ itemId: '00000000-0000-4000-8000-00000000dead', quantity: 1 }]),
    ).rejects.toBeInstanceOf(OrderTransitionError);
    await expect(
      edit(orderId, [
        { itemId: id, quantity: 1 },
        { itemId: id, quantity: 0 },
      ]),
    ).rejects.toBeInstanceOf(OrderTransitionError);
    for (const quantity of [-1, 1001, 1.5]) {
      await expect(edit(orderId, [{ itemId: id, quantity }])).rejects.toBeInstanceOf(
        OrderTransitionError,
      );
    }
    await admin.db.execute(sql`UPDATE orders SET fiscal_status = 'issued' WHERE id = ${orderId}`);
    await expect(edit(orderId, [{ itemId: id, quantity: 1 }])).rejects.toBeInstanceOf(
      OrderTransitionError,
    );
    await admin.db.execute(
      sql`UPDATE orders SET fiscal_status = 'not_required' WHERE id = ${orderId}`,
    );
    await admin.db.transaction(
      async (tx) => await cancelOrder(tx, { orderId, source: 'admin', reason: 'x' }),
    );
    await expect(edit(orderId, [{ itemId: id, quantity: 1 }])).rejects.toBeInstanceOf(
      OrderTransitionError,
    );
    const other = await place([[v2, 1]]);
    await markPaid(other);
    await admin.db.transaction(
      async (tx) => await shipOrder(tx, { orderId: other, source: 'admin' }),
    );
    const [shippedItem] = await itemsOf(other);
    await expect(
      edit(other, [{ itemId: shippedItem?.id ?? '', quantity: 2 }]),
    ).rejects.toBeInstanceOf(OrderTransitionError);
  });

  it('a repeat of the same edit is a no-op with no second history row', async () => {
    const orderId = await place([[v1, 2]]);
    const [item] = await itemsOf(orderId);
    expect(await edit(orderId, [{ itemId: item?.id ?? '', quantity: 1 }])).toMatchObject({
      changed: true,
    });
    expect(await edit(orderId, [{ itemId: item?.id ?? '', quantity: 1 }])).toMatchObject({
      changed: false,
    });
    expect(await historyEdits(orderId)).toBe(1);
  });

  it('a rolled-back edit leaves lines, totals, reservation and stock exactly as they were', async () => {
    const orderId = await place([[v1, 2]]);
    const [item] = await itemsOf(orderId);
    const before = await orderRow(orderId);
    await expect(
      admin.db.transaction(async (tx) => {
        await editOrderItems(tx, {
          orderId,
          changes: [{ itemId: item?.id ?? '', quantity: 1 }],
          reason: 'x y z',
          actorUserId: USER,
        });
        throw new Error('caller failed afterwards');
      }),
    ).rejects.toThrow('caller failed');
    expect(await orderRow(orderId)).toEqual(before);
    expect((await itemsOf(orderId))[0]?.qty).toBe(2);
    expect(await stockOf(v1)).toEqual({ s: 10, r: 2 });
  });
});

describe('a paid order that is edited (ADR-4: captured money is never typed by hand)', () => {
  it('cheaper: captured stays, the surplus is announced once; dearer: it cannot ship until the money arrives', async () => {
    const orderId = await place([[v1, 2]]);
    await markPaid(orderId);
    const [item] = await itemsOf(orderId);
    const id = item?.id ?? '';
    const result = await edit(orderId, [{ itemId: id, quantity: 1 }]);
    expect(result.refundDue).toBe(129_900);
    expect((await orderRow(orderId))?.captured).toBe(259_800);
    expect(
      await rows(sql`SELECT payload FROM outbox WHERE topic = 'alert.refund-due'`),
    ).toHaveLength(1);
    await edit(orderId, [{ itemId: id, quantity: 3 }]);
    await expect(
      admin.db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 'admin' })),
    ).rejects.toBeInstanceOf(OrderNotShippableError);
    expect((await orderRow(orderId))?.captured).toBe(259_800);
  });
});

describe('races (separate connections)', () => {
  it('two identical edits at once: one applies, one is a no-op, one history row', async () => {
    const orderId = await place([[v1, 3]]);
    const [item] = await itemsOf(orderId);
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      return await handle.db.transaction(async (tx) => {
        await barrier.wait();
        return await editOrderItems(tx, {
          orderId,
          changes: [{ itemId: item?.id ?? '', quantity: 1 }],
          reason: 'race one',
          actorUserId: USER,
        });
      });
    };
    const results = await Promise.all([run(), run()]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await historyEdits(orderId)).toBe(1);
    expect(await stockOf(v1)).toEqual({ s: 10, r: 1 });
    expect(await drift()).toEqual([]);
  });

  it('an edit and a ship together: either order gives a consistent result, never a drift', async () => {
    const orderId = await place([[v1, 3]]);
    await markPaid(orderId);
    const [item] = await itemsOf(orderId);
    const barrier = new Barrier(2);
    const attempt = async (op: 'edit' | 'ship') => {
      const handle = world.connect();
      try {
        return await handle.db.transaction(async (tx) => {
          await barrier.wait();
          return op === 'edit'
            ? await editOrderItems(tx, {
                orderId,
                changes: [{ itemId: item?.id ?? '', quantity: 1 }],
                reason: 'race two',
                actorUserId: USER,
              })
            : await shipOrder(tx, { orderId, source: 'admin' });
        });
      } catch (error) {
        return error;
      }
    };
    await Promise.all([attempt('edit'), attempt('ship')]);
    expect(await drift()).toEqual([]);
    const state = await stockOf(v1);
    const status = (
      await rows<{ status: string }>(sql`SELECT status FROM orders WHERE id = ${orderId}`)
    )[0]?.status;
    if (status === 'shipped') {
      // Shipped what was ordered at that moment (3, or 1 if the edit came first): stock fell by that and reserved is clear.
      expect(state?.r).toBe(0);
      expect([7, 9]).toContain(state?.s);
    } else {
      expect(state).toEqual({ s: 10, r: 1 });
    }
  });
});

describe('review round 1 (#73)', () => {
  it('a larger quantity keeps the line discount it had: a capped promo cannot grow', async () => {
    const orderId = await place([[v1, 3]]);
    const [item] = await itemsOf(orderId);
    await admin.db.execute(
      sql`UPDATE order_items SET line_discount = 1000, line_total = unit_price * 3 - 1000 WHERE order_id = ${orderId}`,
    );
    await admin.db.execute(
      sql`UPDATE orders SET discount_total = 1000, total = subtotal - 1000 + shipping_total + adjustment_total WHERE id = ${orderId}`,
    );
    await edit(orderId, [{ itemId: item?.id ?? '', quantity: 6 }]);
    expect((await orderRow(orderId))?.discount).toBe(1000);
    await edit(orderId, [{ itemId: item?.id ?? '', quantity: 3 }]);
    expect((await orderRow(orderId))?.discount).toBe(500);
  });

  it('an open online payment blocks the edit until it is settled', async () => {
    const orderId = await place([[v1, 2]]);
    const [item] = await itemsOf(orderId);
    await admin.db.execute(
      sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status) SELECT id, 1, 'mono', total, 'in_flight', 'pending' FROM orders WHERE id = ${orderId}`,
    );
    await expect(edit(orderId, [{ itemId: item?.id ?? '', quantity: 1 }])).rejects.toBeInstanceOf(
      OrderPaymentOpenError,
    );
    expect((await itemsOf(orderId))[0]?.qty).toBe(2);
    await admin.db.execute(
      sql`UPDATE payment_attempts SET state = 'failed', status = 'failed' WHERE order_id = ${orderId}`,
    );
    expect(await edit(orderId, [{ itemId: item?.id ?? '', quantity: 1 }])).toMatchObject({
      changed: true,
    });
  });

  it('the surplus nets refunds that are already held; the result lists the lines that really changed', async () => {
    const orderId = await place([[v1, 3]]);
    await markPaid(orderId);
    await admin.db.execute(
      sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id)
          SELECT id, 1, 'mono', total, 'succeeded', 'paid', total, 'inv-held' FROM orders WHERE id = ${orderId}`,
    );
    await admin.db.execute(
      sql`INSERT INTO refund_operations (order_id, payment_attempt_id, amount, state)
          SELECT ${orderId}::uuid, id, 129900, 'unknown'::operation_state FROM payment_attempts WHERE order_id = ${orderId}`,
    );
    const [item] = await itemsOf(orderId);
    const result = await edit(orderId, [{ itemId: item?.id ?? '', quantity: 2 }]);
    // Received 3 x 1299, one unit is already being refunded, the order now costs 2 x 1299: nothing is owed.
    expect(result.refundDue).toBe(0);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ itemId: item?.id, from: 3, to: 2 });
    const noop = await edit(orderId, [{ itemId: item?.id ?? '', quantity: 2 }]);
    expect(noop.applied).toEqual([]);
  });

  it('two lines of one variant are refused (they would share one reservation)', async () => {
    const orderId = await place([[v1, 1]]);
    await admin.db.execute(
      sql`INSERT INTO order_items (order_id, product_uid_snapshot, variant_uid_snapshot, variant_id, name_snapshot, sku_snapshot, size_label, color_name, unit_price, quantity, line_total)
          SELECT order_id, product_uid_snapshot, variant_uid_snapshot, variant_id, name_snapshot, sku_snapshot, size_label, color_name, unit_price, 1, unit_price FROM order_items WHERE order_id = ${orderId}`,
    );
    const [item] = await itemsOf(orderId);
    await expect(edit(orderId, [{ itemId: item?.id ?? '', quantity: 2 }])).rejects.toBeInstanceOf(
      OrderTransitionError,
    );
  });
});
