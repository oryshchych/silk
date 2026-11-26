/**
 * Returns on real Postgres with TWO customers and separate connections for every race: who may ask, the
 * window and the units left, a request that touches nothing, the physical RECEIPT as the only step that
 * changes stock (once, atomically, with history), and the refund as at most one operation in the phase 5
 * flow (no double refund, bounded by the order's budget, a return and a manual refund cannot both pay).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import {
  customers,
  orders,
  refundOperations,
  returnRequests,
  stockAdjustments,
} from '@store/db/schema';
import { MonoProvider } from '@store/payments/mono';
import { money } from '@store/shared/money';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { reserveAdminRefund } from '../src/orders-admin/refund.ts';
import {
  approveReturn,
  closeReturn,
  syncAllReturnRefunds,
  getReturn,
  receiveReturn,
  rejectReturn,
  reserveReturnRefund,
  syncReturnRefund,
  type ReceiveResult,
} from '../src/returns/admin.ts';
import {
  ReturnItemsInvalidError,
  ReturnLimitError,
  ReturnNotEligibleError,
  createReturnRequest,
  listEligibleOrders,
  listMyReturns,
  returnInputSchema,
} from '../src/returns/customer.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const providers = {
  mono: new MonoProvider({
    pageHosts: ['pay.example'],
    baseUrl: 'http://127.0.0.1:1',
    token: 't',
    timeoutMs: 100,
  }),
};
let world: TestWorld;
let handle: DbHandle;
type Who = { customerId: string; userId: string; ip: null };
let a: Who;
let b: Who;
let actor = '';
let variantId = '';
let seq = 0;

async function customer(email: string): Promise<Who> {
  const [user] = await handle.db
    .execute<{ id: string }>(
      sql`INSERT INTO auth_users (email, email_verified_at) VALUES (${email}, now()) RETURNING id`,
    )
    .then((r) => r.rows);
  const [row] = await handle.db
    .insert(customers)
    .values({ email, userId: user?.id ?? null })
    .returning({ id: customers.id });
  return { customerId: row?.id ?? '', userId: user?.id ?? '', ip: null };
}

/** A card order of `quantity` units, paid and DELIVERED just now, owned by `who`. */
async function deliveredOrder(
  who: Who,
  quantity = 3,
): Promise<{ orderId: string; number: string; itemId: string }> {
  seq += 1;
  const token = `tok-returns-${String(seq)}-xxxxxxxxxxxx`;
  await handle.db.execute(
    sql`UPDATE product_variants SET stock_quantity = 100, reserved_quantity = 0 WHERE id = ${variantId}`,
  );
  await handle.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId, quantity });
  });
  const view = await handle.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await handle.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: view.intentId,
        ownerToken: token,
        contact: { email: 'b@example.com', phone: `+38050111${String(1000 + seq)}`, name: 'Buyer' },
        delivery: { method: 'pickup' },
        paymentProvider: 'mono',
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  const orderId = placed.orderId;
  await handle.db.execute(
    sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id)
        SELECT id, 1, 'mono', total, 'succeeded', 'paid', total, ${`inv-${String(seq)}`} FROM orders WHERE id = ${orderId}`,
  );
  await handle.db.execute(
    sql`UPDATE orders SET payment_status = 'paid', captured_total = total, status = 'delivered', delivered_at = now(),
               customer_id = ${who.customerId} WHERE id = ${orderId}`,
  );
  const [o] = await handle.db.select().from(orders).where(eq(orders.id, orderId));
  const item = (
    await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM order_items WHERE order_id = ${orderId}`,
    )
  ).rows[0];
  return { orderId, number: o?.orderNumber ?? '', itemId: item?.id ?? '' };
}

const input = (
  number: string,
  itemId: string,
  quantity: number,
  over: Record<string, unknown> = {},
) =>
  returnInputSchema.parse({
    orderNumber: number,
    reason: 'wrong_size',
    comment: 'too small',
    items: [{ orderItemId: itemId, quantity }],
    ...over,
  });
const request = async (
  who: Who,
  number: string,
  itemId: string,
  quantity: number,
  h: DbHandle = handle,
) =>
  await h.db.transaction(
    async (tx) => await createReturnRequest(tx, who, input(number, itemId, quantity)),
  );
const stockNow = async () =>
  (
    await handle.db.execute<{ s: number }>(
      sql`SELECT stock_quantity AS s FROM product_variants WHERE id = ${variantId}`,
    )
  ).rows[0]?.s ?? -1;
const approve = async (id: string, over: Record<string, unknown> = {}) =>
  await handle.db.transaction(
    async (tx) => await approveReturn(tx, { userId: actor }, { id, restock: true, ...over }),
  );
const receive = async (
  id: string,
  itemId: string,
  total: number,
  h: DbHandle = handle,
): Promise<ReceiveResult> =>
  await h.db.transaction(
    async (tx) =>
      await receiveReturn(
        tx,
        { userId: actor },
        { id, items: [{ itemId, receivedQuantity: total }] },
      ),
  );
const lineOf = async (id: string) =>
  (
    await handle.db.execute<{ id: string; received_quantity: number; restocked_quantity: number }>(
      sql`SELECT id, received_quantity, restocked_quantity FROM return_request_items WHERE return_request_id = ${id}`,
    )
  ).rows[0];

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(10);
  variantId = world.fixture.variantIds[0];
  a = await customer('a@example.test');
  b = await customer('b@example.test');
  actor = (await customer('staff@example.test')).userId;
});
afterAll(async () => {
  await world.close();
});

describe('who may ask, and for how much', () => {
  it('a delivered order of mine inside the window is eligible; another customer\'s number is "not eligible"', async () => {
    const o = await deliveredOrder(a);
    expect((await listEligibleOrders(handle.db, a.customerId)).map((x) => x.orderNumber)).toContain(
      o.number,
    );
    expect(await listEligibleOrders(handle.db, b.customerId)).toEqual([]);
    await expect(request(b, o.number, o.itemId, 1)).rejects.toBeInstanceOf(ReturnNotEligibleError);
    await expect(request(a, 'LS-2026-999999', o.itemId, 1)).rejects.toBeInstanceOf(
      ReturnNotEligibleError,
    );
  });

  it('not delivered, or outside the window (database time), is refused; the window is a setting', async () => {
    const o = await deliveredOrder(a);
    await handle.db.execute(sql`UPDATE orders SET status = 'shipped' WHERE id = ${o.orderId}`);
    await expect(request(a, o.number, o.itemId, 1)).rejects.toBeInstanceOf(ReturnNotEligibleError);
    await handle.db.execute(
      sql`UPDATE orders SET status = 'delivered', delivered_at = now() - interval '15 days' WHERE id = ${o.orderId}`,
    );
    await expect(request(a, o.number, o.itemId, 1)).rejects.toBeInstanceOf(ReturnNotEligibleError);
    await handle.db.execute(
      sql`INSERT INTO settings (key, value) VALUES ('return_window_days', '30'::jsonb)`,
    );
    await expect(request(a, o.number, o.itemId, 1)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await handle.db.execute(sql`DELETE FROM settings WHERE key = 'return_window_days'`);
  });

  it('units are capped by what was ordered minus what non-refused requests hold; a refused request frees them', async () => {
    const o = await deliveredOrder(a, 3);
    await expect(request(a, o.number, o.itemId, 4)).rejects.toBeInstanceOf(ReturnItemsInvalidError);
    const first = await request(a, o.number, o.itemId, 2);
    await expect(request(a, o.number, o.itemId, 2)).rejects.toBeInstanceOf(ReturnItemsInvalidError);
    await handle.db.transaction(async (tx) => {
      await rejectReturn(tx, { userId: actor }, { id: first, note: 'no' });
    });
    await expect(request(a, o.number, o.itemId, 3)).resolves.toBeDefined();
  });

  it('a line of ANOTHER order, an unknown line, a bad quantity and a duplicate line are refused', async () => {
    const o1 = await deliveredOrder(a);
    const o2 = await deliveredOrder(a);
    await expect(request(a, o1.number, o2.itemId, 1)).rejects.toBeInstanceOf(
      ReturnItemsInvalidError,
    );
    await expect(
      request(a, o1.number, '00000000-0000-4000-8000-000000000000', 1),
    ).rejects.toBeInstanceOf(ReturnItemsInvalidError);
    expect(() => input(o1.number, o1.itemId, 0)).toThrow();
    expect(() =>
      returnInputSchema.parse({ orderNumber: o1.number, reason: 'x', comment: '', items: [] }),
    ).toThrow();
    expect(() =>
      returnInputSchema.parse({
        orderNumber: o1.number,
        reason: 'defect',
        comment: '',
        items: [
          { orderItemId: o1.itemId, quantity: 1 },
          { orderItemId: o1.itemId, quantity: 1 },
        ],
      }),
    ).toThrow();
  });

  it('PARALLEL requests for the same units (separate connections): the total never passes what was ordered', async () => {
    const o = await deliveredOrder(a, 3);
    const barrier = new Barrier(4);
    const pools = Array.from({ length: 4 }, () => world.connect(1));
    const results = await Promise.all(
      pools.map(async (pool) => {
        await barrier.wait();
        return await request(a, o.number, o.itemId, 2, pool).then(
          () => 'ok',
          (e: unknown) =>
            e instanceof ReturnItemsInvalidError
              ? 'items'
              : e instanceof ReturnLimitError
                ? 'limit'
                : 'other',
        );
      }),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'other')).toHaveLength(0);
    const held = await handle.db.execute<{ n: number }>(
      sql`SELECT coalesce(sum(ri.quantity), 0)::int AS n FROM return_request_items ri WHERE ri.order_item_id = ${o.itemId}`,
    );
    expect(held.rows[0]?.n).toBe(2);
  });

  it('the text is stored as plain text without control characters; the request touches NO stock and NO money', async () => {
    const o = await deliveredOrder(a, 2);
    const before = await stockNow();
    const id = await handle.db.transaction(
      async (tx) =>
        await createReturnRequest(
          tx,
          a,
          input(o.number, o.itemId, 1, { comment: 'a\u0000b<b>x</b>' }),
        ),
    );
    const [row] = await handle.db.select().from(returnRequests).where(eq(returnRequests.id, id));
    expect(row).toMatchObject({
      status: 'requested',
      customerComment: 'ab<b>x</b>',
      restock: false,
    });
    expect(row?.requestNumber).toMatch(/^RET-\d{4}-\d{5,}$/);
    expect(await stockNow()).toBe(before);
    expect(
      await handle.db
        .select()
        .from(refundOperations)
        .where(eq(refundOperations.orderId, o.orderId)),
    ).toHaveLength(0);
    expect(
      await handle.db.select().from(stockAdjustments).where(eq(stockAdjustments.reason, 'return')),
    ).toHaveLength(0);
  });

  it('a customer lists only THEIR requests, with no admin note or refund data', async () => {
    const mine = await listMyReturns(handle.db, a.customerId);
    expect(mine.length).toBeGreaterThan(0);
    expect(await listMyReturns(handle.db, b.customerId)).toEqual([]);
    const text = JSON.stringify(mine);
    for (const key of ['adminNote', 'refund', 'customerId', 'policy'])
      expect(text).not.toContain(key);
  });

  it('five open requests at most per customer', async () => {
    const c = await customer('many@example.test');
    for (let i = 0; i < 5; i += 1) {
      const o = await deliveredOrder(c, 1);
      await request(c, o.number, o.itemId, 1);
    }
    const o = await deliveredOrder(c, 1);
    await expect(request(c, o.number, o.itemId, 1)).rejects.toBeInstanceOf(ReturnLimitError);
  });
});

describe('the physical receipt is the only step that changes stock', () => {
  // A fresh customer per test: the limit of five open requests is per customer and is tested above.
  beforeEach(async () => {
    seq += 1;
    a = await customer(`receipt-${String(seq)}@example.test`);
  });

  it('approve, reject and refuse never touch stock; only the receipt adds the units, once, with history', async () => {
    const o = await deliveredOrder(a, 3);
    const id = await request(a, o.number, o.itemId, 2);
    const base = await stockNow();
    const approved = await approve(id);
    expect(approved.refundAmount).toBeGreaterThan(0);
    expect(await stockNow()).toBe(base);
    await expect(approve(id)).rejects.toThrow();
    const line = await lineOf(id);
    const first = await receive(id, line?.id ?? '', 1);
    expect(first).toEqual({ received: 1, restocked: 1, changed: true });
    expect(await stockNow()).toBe(base + 1);
    // The same total again changes nothing; a higher total adds only the difference.
    expect(await receive(id, line?.id ?? '', 1)).toMatchObject({ changed: false, restocked: 0 });
    expect(await stockNow()).toBe(base + 1);
    expect(await receive(id, line?.id ?? '', 2)).toMatchObject({ received: 1, restocked: 1 });
    expect(await stockNow()).toBe(base + 2);
    const history = await handle.db
      .select()
      .from(stockAdjustments)
      .where(eq(stockAdjustments.reason, 'return'));
    const mine = history.filter((h) => h.note?.startsWith('return RET-'));
    expect(mine.reduce((sum, h) => sum + h.delta, 0)).toBeGreaterThanOrEqual(2);
    for (const h of mine) expect(h.quantityAfter).toBe(h.quantityBefore + h.delta);
    const dto = await getReturn(handle.db, id);
    expect(dto?.status).toBe('received');
    expect(dto?.items[0]).toMatchObject({ receivedQuantity: 2, restockedQuantity: 2 });
  });

  it('refuses a total above what was requested, a total below what was recorded, and a receipt before approval', async () => {
    const o = await deliveredOrder(a, 3);
    const id = await request(a, o.number, o.itemId, 2);
    const line = await lineOf(id);
    await expect(receive(id, line?.id ?? '', 1)).rejects.toThrow(/approved/);
    await approve(id);
    await expect(receive(id, line?.id ?? '', 3)).rejects.toThrow();
    await receive(id, line?.id ?? '', 2);
    await expect(receive(id, line?.id ?? '', 1)).rejects.toThrow();
  });

  it('RACE: the same receipt on separate connections adds the units exactly once', async () => {
    const o = await deliveredOrder(a, 3);
    const id = await request(a, o.number, o.itemId, 2);
    await approve(id);
    const line = await lineOf(id);
    const base = await stockNow();
    const barrier = new Barrier(4);
    const pools = Array.from({ length: 4 }, () => world.connect(1));
    const results = await Promise.all(
      pools.map(async (pool) => {
        await barrier.wait();
        return await receive(id, line?.id ?? '', 2, pool).then(
          (r) => (r.changed ? 'applied' : 'noop'),
          () => 'refused',
        );
      }),
    );
    expect(results.filter((r) => r === 'applied')).toHaveLength(1);
    expect(await stockNow()).toBe(base + 2);
  });

  it('a request that does not restock (a defect) records the receipt and leaves stock alone', async () => {
    const o = await deliveredOrder(a, 2);
    const id = await request(a, o.number, o.itemId, 1);
    await approve(id, { restock: false });
    const line = await lineOf(id);
    const base = await stockNow();
    expect(await receive(id, line?.id ?? '', 1)).toEqual({
      received: 1,
      restocked: 0,
      changed: true,
    });
    expect(await stockNow()).toBe(base);
    expect((await lineOf(id))?.restocked_quantity).toBe(0);
  });

  it('a refused request cannot be received, and a received one cannot be refused', async () => {
    const o = await deliveredOrder(a, 2);
    const id = await request(a, o.number, o.itemId, 1);
    await handle.db.transaction(async (tx) => {
      await rejectReturn(tx, { userId: actor }, { id, note: 'x' });
    });
    const line = await lineOf(id);
    await expect(receive(id, line?.id ?? '', 1)).rejects.toThrow();
    const o2 = await deliveredOrder(a, 2);
    const id2 = await request(a, o2.number, o2.itemId, 1);
    await approve(id2);
    await receive(id2, (await lineOf(id2))?.id ?? '', 1);
    await expect(
      handle.db.transaction(async (tx) => {
        await rejectReturn(tx, { userId: actor }, { id: id2, note: 'late' });
      }),
    ).rejects.toThrow();
  });
});

describe('the refund: at most one, through the phase 5 flow', () => {
  beforeEach(async () => {
    seq += 1;
    a = await customer(`refund-${String(seq)}@example.test`);
  });

  async function received(): Promise<{ id: string; orderId: string }> {
    const o = await deliveredOrder(a, 2);
    const id = await request(a, o.number, o.itemId, 1);
    await approve(id);
    await receive(id, (await lineOf(id))?.id ?? '', 1);
    return { id, orderId: o.orderId };
  }
  const reserve = async (id: string, h: DbHandle = handle) =>
    await h.db.transaction(
      async (tx) => await reserveReturnRefund(tx, { userId: actor }, { id, providers }),
    );

  it('only a RECEIVED return can be refunded; the amount is the paid price of the returned units', async () => {
    const o = await deliveredOrder(a, 2);
    const id = await request(a, o.number, o.itemId, 1);
    await approve(id);
    await expect(reserve(id)).rejects.toThrow(/received/);
    await receive(id, (await lineOf(id))?.id ?? '', 1);
    const dto = await getReturn(handle.db, id);
    const total =
      (await handle.db.select().from(orders).where(eq(orders.id, o.orderId)))[0]?.total ?? 0;
    expect(dto?.suggestedRefund).toBe(Math.floor(total / 2));
    expect(dto?.refundAmount).toBe(dto?.suggestedRefund);
  });

  it('reserves ONE operation, linked to the return; a second call and PARALLEL calls make no second refund', async () => {
    const r = await received();
    const barrier = new Barrier(4);
    const pools = Array.from({ length: 4 }, () => world.connect(1));
    const results = await Promise.all(
      pools.map(async (pool) => {
        await barrier.wait();
        return await reserve(r.id, pool).then(
          () => 'ok',
          () => 'refused',
        );
      }),
    );
    expect(results.filter((x) => x === 'ok')).toHaveLength(1);
    const ops = await handle.db
      .select()
      .from(refundOperations)
      .where(eq(refundOperations.orderId, r.orderId));
    expect(ops).toHaveLength(1);
    const [row] = await handle.db.select().from(returnRequests).where(eq(returnRequests.id, r.id));
    expect(row?.refundOperationId).toBe(ops[0]?.id);
    await expect(reserve(r.id)).rejects.toThrow(/already/);
  });

  it('the status becomes "refunded" only when the operation SUCCEEDED, never before', async () => {
    const r = await received();
    await reserve(r.id);
    expect(await handle.db.transaction(async (tx) => await syncReturnRefund(tx, r.id))).toBe(false);
    await handle.db.execute(
      sql`UPDATE refund_operations SET state = 'succeeded' WHERE order_id = ${r.orderId}`,
    );
    expect(await handle.db.transaction(async (tx) => await syncReturnRefund(tx, r.id))).toBe(true);
    expect((await getReturn(handle.db, r.id))?.status).toBe('refunded');
    expect(await handle.db.transaction(async (tx) => await syncReturnRefund(tx, r.id))).toBe(false);
  });

  it('a manual refund that already took the money leaves nothing for the return (the order budget bounds both)', async () => {
    const r = await received();
    await handle.db.transaction(async (tx) => {
      await reserveAdminRefund(tx, {
        orderId: r.orderId,
        reason: 'manual full',
        actorUserId: actor,
        providers,
      });
    });
    await expect(reserve(r.id)).rejects.toThrow();
    expect(
      await handle.db
        .select()
        .from(refundOperations)
        .where(eq(refundOperations.orderId, r.orderId)),
    ).toHaveLength(1);
  });

  it('close: a received return without a refund can be closed (cash on delivery); one with a refund cannot', async () => {
    const r = await received();
    await handle.db.transaction(async (tx) => {
      await closeReturn(tx, { userId: actor }, r.id);
    });
    expect((await getReturn(handle.db, r.id))?.status).toBe('closed');
    const r2 = await received();
    await reserve(r2.id);
    await expect(
      handle.db.transaction(async (tx) => {
        await closeReturn(tx, { userId: actor }, r2.id);
      }),
    ).rejects.toThrow();
    expect(money(1)).toBe(1);
  });
});

describe('the refund pays what was RECEIVED, retries after a failed one, and the invariants', () => {
  beforeEach(async () => {
    seq += 1;
    a = await customer(`amount-${String(seq)}@example.test`);
  });
  const reserve = async (id: string, h: DbHandle = handle) =>
    await h.db.transaction(
      async (tx) => await reserveReturnRefund(tx, { userId: actor }, { id, providers }),
    );
  const orderTotals = async (orderId: string) =>
    (
      await handle.db.execute<{ total: number; lt: number }>(
        sql`SELECT o.total, (SELECT line_total FROM order_items WHERE order_id = o.id) AS lt FROM orders o WHERE o.id = ${orderId}`,
      )
    ).rows[0];
  const refundOf = async (orderId: string) =>
    await handle.db.select().from(refundOperations).where(eq(refundOperations.orderId, orderId));

  it('B1: ordered 3, requested 3, received 1: the refund is one third of the line, not the whole order', async () => {
    const o = await deliveredOrder(a, 3);
    const id = await request(a, o.number, o.itemId, 3);
    await approve(id);
    await receive(id, (await lineOf(id))?.id ?? '', 1);
    await reserve(id);
    const ops = await refundOf(o.orderId);
    const t = await orderTotals(o.orderId);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.amount).toBe(Math.round((t?.lt ?? 0) / 3));
    expect(ops[0]?.amount).toBeLessThan(t?.total ?? 0);
  });

  it('S3: an indivisible line returned in three parts refunds EXACTLY the line total (333 + 334 + 333, no kopiyka lost)', async () => {
    const o = await deliveredOrder(a, 3);
    await handle.db.execute(
      sql`UPDATE order_items SET unit_price = 334, line_discount = 2, line_total = 1000 WHERE id = ${o.itemId}`,
    );
    const amounts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await request(a, o.number, o.itemId, 1);
      await approve(id);
      await receive(id, (await lineOf(id))?.id ?? '', 1);
      await handle.db.execute(
        sql`UPDATE refund_operations SET state = 'succeeded' WHERE order_id = ${o.orderId}`,
      );
      // The captured budget of the fixture is the whole order, so the parts fit.
      await reserve(id);
      const ops = await refundOf(o.orderId);
      amounts.push(ops[ops.length - 1]?.amount ?? 0);
    }
    expect(amounts.sort((x, y) => x - y)).toEqual([333, 333, 334]);
    expect(amounts.reduce((x, y) => x + y, 0)).toBe(1000);
  });

  it('S2: approval cannot grant more than the returned units are worth; a receipt after a refund started is refused', async () => {
    const o = await deliveredOrder(a, 2);
    const id = await request(a, o.number, o.itemId, 1);
    const t = await orderTotals(o.orderId);
    await expect(approve(id, { refundAmount: t?.total ?? 0 })).rejects.toThrow(/worth/);
    await approve(id, { refundAmount: 1 });
    await receive(id, (await lineOf(id))?.id ?? '', 1);
    await reserve(id);
    await expect(receive(id, (await lineOf(id))?.id ?? '', 1)).rejects.toThrow();
    // The agreed amount is a CEILING: the refund is min(agreed, received value).
    expect((await refundOf(o.orderId))[0]?.amount).toBe(1);
  });

  it('B2: a FAILED refund releases the return: it can be retried (a new operation) or closed; unknown and succeeded still block', async () => {
    const o = await deliveredOrder(a, 2);
    const id = await request(a, o.number, o.itemId, 1);
    await approve(id);
    await receive(id, (await lineOf(id))?.id ?? '', 1);
    await reserve(id);
    await handle.db.execute(
      sql`UPDATE refund_operations SET state = 'unknown' WHERE order_id = ${o.orderId}`,
    );
    await expect(reserve(id)).rejects.toThrow(/already/);
    await handle.db.execute(
      sql`UPDATE refund_operations SET state = 'failed' WHERE order_id = ${o.orderId}`,
    );
    await reserve(id);
    const ops = await refundOf(o.orderId);
    expect(ops).toHaveLength(2);
    expect(ops.filter((op) => op.state !== 'failed')).toHaveLength(1);
    expect(new Set(ops.map((op) => op.returnRequestId))).toEqual(new Set([id]));
    // Two live refunds for one return cannot exist (the partial unique index): pinned by name.
    await expect(
      handle.pool.query(`UPDATE refund_operations SET state = 'pending' WHERE order_id = $1`, [
        o.orderId,
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'refund_ops_return_live_uq' });
    // And the failed one can be given up on instead.
    const o2 = await deliveredOrder(a, 2);
    const id2 = await request(a, o2.number, o2.itemId, 1);
    await approve(id2);
    await receive(id2, (await lineOf(id2))?.id ?? '', 1);
    await reserve(id2);
    await handle.db.execute(
      sql`UPDATE refund_operations SET state = 'failed' WHERE order_id = ${o2.orderId}`,
    );
    await handle.db.transaction(async (tx) => {
      await closeReturn(tx, { userId: actor }, id2);
    });
    expect((await getReturn(handle.db, id2))?.status).toBe('closed');
  });

  it('S4: the status change to refunded is audited (by the action and by the worker sweep), and the sweep catches up', async () => {
    const o = await deliveredOrder(a, 2);
    const id = await request(a, o.number, o.itemId, 1);
    await approve(id);
    await receive(id, (await lineOf(id))?.id ?? '', 1);
    await reserve(id);
    await handle.db.execute(
      sql`UPDATE refund_operations SET state = 'succeeded' WHERE order_id = ${o.orderId}`,
    );
    const done = await handle.db.transaction(async (tx) => await syncAllReturnRefunds(tx));
    expect(done).toContain(id);
    expect((await getReturn(handle.db, id))?.status).toBe('refunded');
    const audit = await handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'return.refunded' AND entity_id = ${id}`,
    );
    expect(audit.rows[0]?.n).toBe(1);
    expect(await handle.db.transaction(async (tx) => await syncAllReturnRefunds(tx))).not.toContain(
      id,
    );
  });

  it('S5: the database ties a return to a refund of the SAME order, to a consistent status, and an amount (by constraint name)', async () => {
    const o1 = await deliveredOrder(a, 2);
    const o2 = await deliveredOrder(a, 2);
    const id = await request(a, o1.number, o1.itemId, 1);
    await approve(id);
    const foreign = await handle.db.execute<{ id: string }>(
      sql`INSERT INTO refund_operations (order_id, amount) VALUES (${o2.orderId}, 10) RETURNING id`,
    );
    await expect(
      handle.pool.query(`UPDATE return_requests SET refund_operation_id = $1 WHERE id = $2`, [
        foreign.rows[0]?.id,
        id,
      ]),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'return_requests_refund_op_same_order_fk',
    });
    await expect(
      handle.pool.query(`UPDATE return_requests SET received_at = now() WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'return_requests_received_status' });
    const b = await customer(`amountless-${String(seq)}@example.test`);
    const o3 = await deliveredOrder(b, 1);
    const id3 = await request(b, o3.number, o3.itemId, 1);
    const own = await handle.db.execute<{ id: string }>(
      sql`INSERT INTO refund_operations (order_id, amount) VALUES (${o3.orderId}, 10) RETURNING id`,
    );
    await expect(
      handle.pool.query(`UPDATE return_requests SET refund_operation_id = $1 WHERE id = $2`, [
        own.rows[0]?.id,
        id3,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'return_requests_refund_needs_amount' });
    await expect(
      handle.pool.query(`DELETE FROM refund_operations WHERE id = $1`, [foreign.rows[0]?.id]),
    ).resolves.toBeDefined();
  });

  it('S7: bidi overrides and zero-width characters are stripped from the customer comment and the moderator note', async () => {
    const o = await deliveredOrder(a, 2);
    const parsed = input(o.number, o.itemId, 1, { comment: 'ok\u202Eevil\u200B\u2066x' });
    expect(parsed.comment).toBe('okevilx');
    const id = await request(a, o.number, o.itemId, 1);
    const { rejectSchema } = await import('../src/returns/admin.ts');
    expect(rejectSchema.parse({ id, note: 'no\u202Ethanks\u200B' }).note).toBe('nothanks');
  });
});

describe('S1: the guards are exercised DETERMINISTICALLY (a competing transaction holds the lock)', () => {
  beforeEach(async () => {
    seq += 1;
    a = await customer(`locks-${String(seq)}@example.test`);
  });

  /** Runs `work` while another connection holds `hold`; reports whether `work` finished BEFORE the lock was released. */
  async function whileHeld(
    hold: string,
    work: () => Promise<unknown>,
  ): Promise<{ finishedEarly: boolean }> {
    const holder = world.connect(1);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const heldTx = holder.db.transaction(async (tx) => {
      await tx.execute(sql.raw(hold));
      locked();
      await gate;
    });
    await acquired;
    let finished = false;
    const running = work().then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const finishedEarly = finished;
    release();
    await heldTx;
    await running;
    return { finishedEarly };
  }

  it('a receipt WAITS while another transaction holds the per-return lock, and while it holds the order row', async () => {
    const o = await deliveredOrder(a, 3);
    const id = await request(a, o.number, o.itemId, 2);
    await approve(id);
    const line = (await lineOf(id))?.id ?? '';
    const returnLock = `SELECT pg_advisory_xact_lock(hashtextextended('return:${id}', 0))`;
    expect(
      (await whileHeld(returnLock, async () => await receive(id, line, 1))).finishedEarly,
    ).toBe(false);
    const orderRow = `SELECT id FROM orders WHERE id = '${o.orderId}' FOR UPDATE`;
    expect((await whileHeld(orderRow, async () => await receive(id, line, 2))).finishedEarly).toBe(
      false,
    );
    expect((await lineOf(id))?.received_quantity).toBe(2);
  });

  it('a new request WAITS while another transaction holds the order row (FOR NO KEY UPDATE, which a plain foreign-key insert does not conflict with: only the explicit lock waits)', async () => {
    const o = await deliveredOrder(a, 3);
    const orderRow = `SELECT id FROM orders WHERE id = '${o.orderId}' FOR NO KEY UPDATE`;
    const result = await whileHeld(orderRow, async () => await request(a, o.number, o.itemId, 1));
    expect(result.finishedEarly).toBe(false);
    const orderRows = await handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM return_requests WHERE order_id = ${o.orderId}`,
    );
    expect(orderRows.rows[0]?.n).toBe(1);
  });
});
