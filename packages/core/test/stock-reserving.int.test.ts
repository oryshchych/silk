/**
 * Owner queue Q44: a stocktake below the reserved quantity is refused, and the screen can list the
 * orders that hold the reservation. The invariant under test: what the list shows adds up to the
 * reserved counter that caused the refusal.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import { listReservingOrders, reservationView } from '../src/catalog-admin/stock-read.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { cancelOrder } from '../src/orders/fulfilment.ts';
import { adjustStock, StockBelowReservedError } from '../src/stock/adjust-stock.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;
let v1: string;
let seq = 0;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  [v1] = world.fixture.variantIds;
  await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 10`);
});
afterEach(async () => {
  await world.close();
});

async function place(quantity: number): Promise<string> {
  seq += 1;
  const token = `tok-stock-reserving-${String(seq)}`.padEnd(20, 'x');
  await admin.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId: v1, quantity });
  });
  const view = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  return (
    await admin.db.transaction(
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
    )
  ).orderId;
}

describe('the orders behind a reservation', () => {
  it('lists live reservations only, in order, and they add up to the reserved counter', async () => {
    const a = await place(2);
    const b = await place(3);
    const c = await place(1);
    await admin.db.transaction(
      async (tx) => await cancelOrder(tx, { orderId: c, source: 'admin', reason: 'test cancel' }),
    );
    const list = await listReservingOrders(admin.db, v1);
    expect(list.map((row) => row.orderId)).toEqual([a, b]);
    expect(list.map((row) => row.quantity)).toEqual([2, 3]);
    const reserved = (
      await admin.db.execute<{ r: number }>(
        sql`SELECT reserved_quantity AS r FROM product_variants WHERE id = ${v1}`,
      )
    ).rows[0]?.r;
    expect(list.reduce((total, row) => total + row.quantity, 0)).toBe(reserved);
    expect(list[0]).toMatchObject({ status: 'pending', expires: true });
    expect(Object.keys(list[0] ?? {}).sort()).toEqual([
      'at',
      'expires',
      'orderId',
      'orderNumber',
      'quantity',
      'status',
    ]);
  });

  it('a stocktake below the reserved quantity is refused, and the list explains it', async () => {
    await place(4);
    await place(3);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await adjustStock(tx, {
            variantId: v1,
            change: { kind: 'set', quantity: 5 },
            reason: 'stocktake',
            note: null,
            userId: null,
            requestId: crypto.randomUUID(),
          }),
      ),
    ).rejects.toBeInstanceOf(StockBelowReservedError);
    const list = await listReservingOrders(admin.db, v1);
    expect(list.reduce((total, row) => total + row.quantity, 0)).toBe(7);
  });

  it('an unknown variant or a malformed id gives an empty list, and the limit is bounded', async () => {
    expect(await listReservingOrders(admin.db, '00000000-0000-4000-8000-00000000dead')).toEqual([]);
    for (let i = 0; i < 3; i += 1) await place(1);
    expect(await listReservingOrders(admin.db, v1, 2)).toHaveLength(2);
    expect(await listReservingOrders(admin.db, v1, -5)).toHaveLength(1);
    expect(await listReservingOrders(admin.db, v1, 100_000)).toHaveLength(3);
  });
});

describe('what a role may see of a reservation', () => {
  it('a role without orders.view gets the quantity only: the orders are not read for it', async () => {
    const a = await place(2);
    await place(1);
    const content = await reservationView(admin.db, v1, false);
    expect(content).toEqual({ reserved: 3, orders: null });
    expect(JSON.stringify(content)).not.toContain(a);
    expect(JSON.stringify(content)).not.toMatch(/LS-\d{4}-/);
    const manager = await reservationView(admin.db, v1, true);
    expect(manager.reserved).toBe(3);
    expect(manager.orders?.map((row) => row.orderId)).toContain(a);
  });

  it('an unknown variant has no reservation', async () => {
    expect(await reservationView(admin.db, '00000000-0000-4000-8000-00000000dead', false)).toEqual({
      reserved: 0,
      orders: null,
    });
  });
});
