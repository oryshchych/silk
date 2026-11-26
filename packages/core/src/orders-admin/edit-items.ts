/**
 * Editing the composition of an order before it ships (phase 5): change a quantity or take a line
 * off. The goods stay reserved (ADR-18): a smaller quantity releases part of the reservation, a
 * larger one takes more with the same atomic conditional UPDATE as checkout (ADR-3), and
 * `stock_quantity` is never touched. The totals are recomputed from the lines in ONE place, so the
 * order's own CHECK (`total = subtotal - discount + shipping + adjustment`) always holds.
 *
 * What it does not do: it never changes `captured_total` (that is derived from payments only,
 * ADR-4) and never refunds. A paid order that now costs less than was received announces the
 * surplus through the outbox for the refund flow; one that costs more cannot ship until the extra
 * money is received (`shipOrder` compares captured with total). A fiscal receipt that exists (or is
 * queued) blocks the edit: the receipt would no longer match the order.
 *
 * Lock order (ADR-22): orders (3), order_items (4), product_variants (8, ascending).
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  orderItems,
  orderStatusHistory,
  paymentAttempts,
  orders,
  outbox,
  refundOperations,
  shipmentOperations,
  stockReservations,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { money, prorate } from '@store/shared/money';

import { AdminNotFoundError } from '../catalog-admin/errors.ts';
import {
  InsufficientStockError,
  OrderHasWaybillError,
  OrderPaymentOpenError,
  OrderTransitionError,
  StockDriftError,
} from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { ADMIN_SOURCE } from './workflow.ts';

export interface ItemChange {
  itemId: string;
  /** The new quantity; 0 takes the line off the order. */
  quantity: number;
}

export interface EditItemsResult {
  orderId: string;
  changed: boolean;
  totalFrom: number;
  totalTo: number;
  /** Received money the cheaper order no longer needs: a human starts the refund. */
  refundDue: number;
  /** What really changed, per line: the audit row records this, not the request. */
  applied: { itemId: string; sku: string; from: number; to: number }[];
}

const EDITABLE = ['pending', 'confirmed', 'processing'];

export async function editOrderItems(
  tx: Tx,
  input: { orderId: string; changes: readonly ItemChange[]; reason: string; actorUserId: string },
): Promise<EditItemsResult> {
  if (
    input.changes.some(
      (change) =>
        !Number.isInteger(change.quantity) || change.quantity < 0 || change.quantity > 1000,
    )
  ) {
    throw new OrderTransitionError('a quantity is a whole number from 0 to 1000');
  }
  if (new Set(input.changes.map((change) => change.itemId)).size !== input.changes.length) {
    throw new OrderTransitionError('a line is listed twice');
  }
  await acquireLocks(tx, { orders: [input.orderId] });
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (order === undefined) throw new AdminNotFoundError('order');
  if (!EDITABLE.includes(order.status)) {
    throw new OrderTransitionError(`the order is ${order.status}`);
  }
  if (order.fiscalStatus !== 'not_required') {
    throw new OrderTransitionError('a fiscal receipt exists or is queued for this order');
  }
  // A waybill carries the declared value and the COD amount: after it exists (or while it is being
  // made) an edit would leave the carrier with the old figures.
  const [shipment] = await tx
    .select({ id: shipmentOperations.id })
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.orderId, order.id),
        inArray(shipmentOperations.state, ['pending', 'in_flight', 'unknown', 'succeeded']),
      ),
    )
    .limit(1);
  if (shipment !== undefined) throw new OrderHasWaybillError();
  // An unpaid online order has a payment attempt (and a provider invoice) at the OLD amount: a
  // customer could still pay it. Editing waits until it is settled or the order is cancelled.
  const [open] = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, order.id),
        inArray(paymentAttempts.state, ['pending', 'in_flight']),
        inArray(paymentAttempts.status, ['pending', 'authorized']),
      ),
    )
    .limit(1);
  if (open !== undefined) throw new OrderPaymentOpenError();
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  // The reservation of a variant is one row per order; two lines of one variant would share it.
  if (new Set(items.map((item) => item.variantId)).size !== items.length) {
    throw new OrderTransitionError('two lines share a variant: edit is not supported');
  }
  await acquireLocks(tx, { order_items: items.map((item) => item.id) });

  // Only real differences count: a repeat of the same edit is a no-op, not a second history row.
  const byId = new Map(items.map((item) => [item.id, item]));
  const effective = input.changes.flatMap((change) => {
    const item = byId.get(change.itemId);
    if (item === undefined) throw new OrderTransitionError('the line is not on this order');
    if (item.variantId === null) throw new OrderTransitionError('the product of this line is gone');
    return change.quantity === item.quantity ? [] : [{ item, quantity: change.quantity }];
  });
  if (effective.length === 0) {
    return {
      orderId: order.id,
      changed: false,
      totalFrom: order.total,
      totalTo: order.total,
      refundDue: 0,
      applied: [],
    };
  }
  const removed = new Set(effective.filter((e) => e.quantity === 0).map((e) => e.item.id));
  if (items.every((item) => removed.has(item.id))) {
    throw new OrderTransitionError('an order cannot lose every line: cancel it');
  }

  const reservations = await tx
    .select()
    .from(stockReservations)
    .where(and(eq(stockReservations.orderId, order.id), isNull(stockReservations.releasedAt)))
    .orderBy(asc(stockReservations.variantId));
  const variantIds = [
    ...new Set(effective.flatMap((e) => (e.item.variantId === null ? [] : [e.item.variantId]))),
  ];
  await acquireLocks(tx, { product_variants: variantIds });

  const notes: string[] = [];
  for (const { item, quantity } of effective) {
    const variantId = item.variantId;
    if (variantId === null) continue;
    const delta = quantity - item.quantity;
    const reservation = reservations.find((r) => r.variantId === variantId);
    if (reservation === undefined) throw new OrderTransitionError('no live reservation');
    if (delta > 0) {
      const taken = await tx.execute(
        sql`UPDATE product_variants SET reserved_quantity = reserved_quantity + ${delta}
             WHERE id = ${variantId} AND is_active
               AND stock_quantity - reserved_quantity >= ${delta}
            RETURNING id`,
      );
      if (taken.rows.length === 0) {
        throw new InsufficientStockError([{ variantId, requested: quantity, available: 0 }]);
      }
    } else {
      const freed = await tx.execute(
        sql`UPDATE product_variants SET reserved_quantity = reserved_quantity - ${-delta}
             WHERE id = ${variantId} AND reserved_quantity >= ${-delta}
            RETURNING id`,
      );
      if (freed.rows.length === 0) throw new StockDriftError('reserved counter below the edit');
    }
    if (quantity === 0) {
      const closed = await tx.execute(
        sql`UPDATE stock_reservations SET released_at = now(), release_reason = 'cancelled'
             WHERE id = ${reservation.id} AND released_at IS NULL RETURNING id`,
      );
      if (closed.rows.length === 0) throw new StockDriftError('reservation vanished');
      await tx.delete(orderItems).where(eq(orderItems.id, item.id));
    } else {
      const moved = await tx.execute(
        sql`UPDATE stock_reservations SET quantity = quantity + ${delta}
             WHERE id = ${reservation.id} AND released_at IS NULL AND quantity + ${delta} > 0
            RETURNING id`,
      );
      if (moved.rows.length === 0) throw new StockDriftError('reservation does not cover the edit');
      // A smaller quantity keeps its share of the discount (one half-up rounding); a larger one
      // keeps the discount it had: never scaled UP, so a capped or fixed promo cannot exceed its
      // limit. Thresholds (minimum order, free shipping) are not re-evaluated, see the PR notes.
      const discount =
        quantity >= item.quantity
          ? money(item.lineDiscount)
          : prorate(money(item.lineDiscount), quantity, item.quantity);
      await tx
        .update(orderItems)
        .set({
          quantity,
          lineDiscount: discount,
          lineTotal: sql`${orderItems.unitPrice} * ${quantity} - ${discount}`,
        })
        .where(eq(orderItems.id, item.id));
    }
    notes.push(
      `${item.skuSnapshot}: ${String(item.quantity)} -> ${quantity === 0 ? 'removed' : String(quantity)}`,
    );
  }

  // Recompute every total from the lines that remain, in the database, so nothing is typed by hand.
  const [totals] = await tx
    .select({
      subtotal: sql<number>`coalesce(sum(${orderItems.unitPrice} * ${orderItems.quantity}), 0)::int`,
      discount: sql<number>`coalesce(sum(${orderItems.lineDiscount}), 0)::int`,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const subtotal = totals?.subtotal ?? 0;
  const discount = totals?.discount ?? 0;
  const total = subtotal - discount + order.shippingTotal + order.adjustmentTotal;
  await tx
    .update(orders)
    .set({ subtotal, discountTotal: discount, total })
    .where(eq(orders.id, order.id));

  const comment = `${notes.join('; ')}; total ${String(order.total)} -> ${String(total)}; ${input.reason}`;
  await tx.insert(orderStatusHistory).values({
    orderId: order.id,
    fromStatus: null,
    toStatus: 'edited',
    field: 'items',
    changedByUserId: input.actorUserId,
    source: ADMIN_SOURCE,
    comment,
  });

  let refundDue = 0;
  if (order.capturedTotal > 0 && total < order.capturedTotal) {
    const [held] = await tx
      .select({ sum: sql<number>`coalesce(sum(${refundOperations.amount}), 0)::int` })
      .from(refundOperations)
      .where(
        and(
          eq(refundOperations.orderId, order.id),
          inArray(refundOperations.state, ['pending', 'in_flight', 'unknown', 'succeeded']),
        ),
      );
    refundDue = Math.max(0, order.capturedTotal - (held?.sum ?? 0) - total);
    if (refundDue > 0) {
      await tx
        .insert(outbox)
        .values({
          topic: 'alert.refund-due',
          payload: { orderId: order.id, refundable: refundDue, heldAuthorization: false },
          dedupKey: `refund-due:edit:${order.id}:${String(total)}`,
        })
        .onConflictDoNothing();
    }
  }
  return {
    orderId: order.id,
    changed: true,
    totalFrom: order.total,
    totalTo: total,
    refundDue,
    applied: effective.map((e) => ({
      itemId: e.item.id,
      sku: e.item.skuSnapshot,
      from: e.item.quantity,
      to: e.quantity,
    })),
  };
}
