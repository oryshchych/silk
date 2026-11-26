/**
 * Fulfilment transitions that touch stock (ADR-18). Three DIFFERENT operations,
 * deliberately not synonyms:
 *
 *   release reservation  -> cancelOrder: the reservation closes, stock_quantity is untouched
 *   ship stock           -> shipOrder:   stock_quantity -= q AND reserved_quantity -= q, once
 *   receive return       -> a later slice (physical receipt, stock_quantity += q)
 *
 * Lock order (ADR-22): orders (3), then promo_codes (6), then product_variants
 * (8, ascending). cancelOrder takes the same promo-then-variants order as
 * createOrder, so the two cannot deadlock.
 *
 * Both are idempotent under the order lock: a repeat sees the new status and
 * changes nothing, and every reservation is closed by a CONDITIONAL update
 * (`released_at IS NULL`), with the denormalised counters moved only for the
 * rows that really changed.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  auditLog,
  orderItems,
  orderStatusHistory,
  orders,
  outbox,
  paymentAttempts,
  promoCodeRedemptions,
  refundOperations,
  stockReservations,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { OrderNotCancellableError, OrderNotShippableError, StockDriftError } from '../errors.ts';
import { enqueueSaleReceipt } from '../fiscal/receipts.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { canTransition } from './transitions.ts';

export interface FulfilmentResult {
  orderId: string;
  /** False when an earlier call already did it: nothing changed. */
  changed: boolean;
  /** The status the order had before this call: what an audit row records as `from`. */
  from: string;
  /** Cancel only: money received that nobody has refunded yet (a human starts the refund). */
  refundable?: number;
  /** Cancel only: a card hold is still open at the provider and must be released. */
  heldAuthorization?: boolean;
}

type Order = typeof orders.$inferSelect;

async function lockedOrder(tx: Tx, orderId: string): Promise<Order | undefined> {
  await acquireLocks(tx, { orders: [orderId] });
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  return order;
}

/** Sum of the refunds that hold budget: pending, in_flight, unknown and succeeded. */
async function heldRefundTotal(tx: Tx, orderId: string): Promise<number> {
  const [held] = await tx
    .select({ sum: sql<number>`coalesce(sum(${refundOperations.amount}), 0)::int` })
    .from(refundOperations)
    .where(
      and(
        eq(refundOperations.orderId, orderId),
        inArray(refundOperations.state, ['pending', 'in_flight', 'unknown', 'succeeded']),
      ),
    );
  return held?.sum ?? 0;
}

async function liveReservations(tx: Tx, orderId: string) {
  return await tx
    .select({
      id: stockReservations.id,
      variantId: stockReservations.variantId,
      quantity: stockReservations.quantity,
    })
    .from(stockReservations)
    .where(and(eq(stockReservations.orderId, orderId), isNull(stockReservations.releasedAt)))
    .orderBy(asc(stockReservations.variantId));
}

/** Closes one reservation exactly once; returns the quantity only if THIS call closed it. */
async function closeReservation(tx: Tx, id: string, reason: 'shipped' | 'cancelled' | 'expired') {
  const closed = await tx.execute<{ quantity: number }>(
    sql`UPDATE stock_reservations SET released_at = now(), release_reason = ${reason}
         WHERE id = ${id} AND released_at IS NULL
        RETURNING quantity`,
  );
  return closed.rows[0]?.quantity ?? null;
}

/**
 * Who did it. `actorUserId` goes into the history row (the author of an admin action);
 * `auditByCaller` says the caller writes the audit row itself (the admin action does, so the row
 * carries the author's address and there is one row, not two).
 */
export interface Actor {
  actorUserId?: string | null;
  auditByCaller?: boolean;
}

async function recordTransition(
  tx: Tx,
  order: Order,
  to: 'shipped' | 'cancelled',
  source: string,
  comment: string | null,
  actor: Actor,
): Promise<void> {
  await tx.insert(orderStatusHistory).values({
    orderId: order.id,
    fromStatus: order.status,
    toStatus: to,
    field: 'status',
    changedByUserId: actor.actorUserId ?? null,
    source,
    comment,
  });
  if (actor.auditByCaller === true) return;
  await tx.insert(auditLog).values({
    userId: actor.actorUserId ?? null,
    action: 'transition',
    entity: 'order',
    entityId: order.id,
    diff: { source, field: 'status', from: order.status, to },
  });
}

/**
 * Ship: the one place where stock_quantity goes down. In the skeleton the
 * intermediate statuses (confirmed, processing) are skipped and the history
 * records the jump; the admin flow of phase 5 walks them one by one.
 */
export async function shipOrder(
  tx: Tx,
  input: {
    orderId: string;
    source: string;
    /**
     * The admin workflow: only a confirmed or processing order ships (confirm and process are not
     * skipped). Off by default: the skeleton jump from pending stays for the webhook and worker
     * paths and their tests (see `transitions.ts`).
     */
    requireConfirmed?: boolean;
  } & Actor,
): Promise<FulfilmentResult> {
  const order = await lockedOrder(tx, input.orderId);
  if (order === undefined) throw new OrderNotShippableError('no such order');
  if (order.status === 'shipped' || order.status === 'delivered') {
    return { orderId: order.id, changed: false, from: order.status };
  }
  if (!canTransition(order.status, 'shipped')) {
    throw new OrderNotShippableError(`the order is ${order.status}`);
  }
  if (input.requireConfirmed === true && order.status === 'pending') {
    throw new OrderNotShippableError('confirm the order first');
  }
  // What lets an order ship (owner queue Q16): a settled payment (card, or a bank transfer the
  // manager confirmed with a bank reference), or, for cash on delivery, the manager's
  // confirmation. A COD order has captured nothing and has no attempt, so no money check applies.
  const isCod = order.paymentProvider === 'cod';
  if (isCod) {
    if (order.status !== 'confirmed' && order.status !== 'processing') {
      throw new OrderNotShippableError('the COD order is not confirmed');
    }
  } else {
    if (order.paymentStatus !== 'paid') {
      throw new OrderNotShippableError('the order is not paid');
    }
    // Money that a refund has reserved, sent or settled is not money the order still holds:
    // shipping while a refund is pending, in flight or unknown would give the customer both goods
    // and money.
    const heldRefunds = await heldRefundTotal(tx, order.id);
    if (order.capturedTotal - heldRefunds < order.total) {
      throw new OrderNotShippableError('a refund covers part of the captured amount');
    }
  }

  const reservations = await liveReservations(tx, order.id);
  // A paid order without a live reservation is the exceptional "late payment" state:
  // a human decides, nothing ships automatically.
  if (reservations.length === 0) throw new OrderNotShippableError('no live reservation');
  // The live reservations must cover exactly what was ordered: no partial shipments here.
  const [items] = await tx
    .select({ n: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int` })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const reserved = reservations.reduce((total, r) => total + r.quantity, 0);
  if ((items?.n ?? 0) !== reserved) {
    throw new OrderNotShippableError('the live reservations do not match the order items');
  }
  await acquireLocks(tx, { product_variants: reservations.map((r) => r.variantId) });

  for (const reservation of reservations) {
    const quantity = await closeReservation(tx, reservation.id, 'shipped');
    // Under the order lock nobody else can close it: a null here is a broken invariant, and
    // continuing would mark the order shipped without taking the goods off the shelf.
    if (quantity === null) throw new StockDriftError(`reservation ${reservation.id} vanished`);
    const moved = await tx.execute(
      sql`UPDATE product_variants
             SET stock_quantity = stock_quantity - ${quantity},
                 reserved_quantity = reserved_quantity - ${quantity}
           WHERE id = ${reservation.variantId}
             AND stock_quantity >= ${quantity} AND reserved_quantity >= ${quantity}
          RETURNING id`,
    );
    // Counters that do not cover a live reservation mean drift: stock:reconcile territory.
    if (moved.rows.length === 0) {
      throw new StockDriftError(`stock counters do not cover reservation ${reservation.id}`);
    }
  }

  await tx
    .update(orders)
    .set({ status: 'shipped', shippedAt: sql`now()` })
    .where(eq(orders.id, order.id));
  await recordTransition(tx, order, 'shipped', input.source, null, input);
  // Cash on delivery: the receipt for the goods is made when the parcel is handed to the post, as
  // a queue job (ADR-16): a fiscal failure never blocks or undoes the shipment.
  if (isCod) await enqueueSaleReceipt(tx, { orderId: order.id, paymentForm: 'cash_on_delivery' });
  return { orderId: order.id, changed: true, from: order.status };
}

/**
 * Cancel: releases the reservation and the promo use. stock_quantity does NOT
 * change (the goods never left the shelf), and a refund of captured money is a
 * separate operation that this only announces.
 */
export async function cancelOrder(
  tx: Tx,
  input: {
    orderId: string;
    source: string;
    reason: string | null;
    /**
     * Worker expiry (ADR-3): cancel only if the order is still unpaid and pending AND every live
     * reservation is past its TTL, judged by Postgres under the order lock. A payment or a
     * manager's confirmation that landed since the scan makes this a no-op.
     */
    expiredOnly?: boolean;
  } & Actor,
): Promise<FulfilmentResult> {
  const order = await lockedOrder(tx, input.orderId);
  if (order === undefined) throw new OrderNotCancellableError('no such order');
  if (order.status === 'cancelled')
    return { orderId: order.id, changed: false, from: order.status };
  if (input.expiredOnly === true) {
    if (order.status !== 'pending' || order.paymentStatus !== 'pending') {
      return { orderId: order.id, changed: false, from: order.status };
    }
    const due = await tx.execute<{ due: boolean }>(
      sql`SELECT count(*) > 0 AND bool_and(expires_at IS NOT NULL AND expires_at <= now()) AS due
            FROM stock_reservations
           WHERE order_id = ${order.id} AND released_at IS NULL`,
    );
    if (due.rows[0]?.due !== true) return { orderId: order.id, changed: false, from: order.status };
    // A card attempt whose result is not known (lost or late webhook) must be reconciled with the
    // provider first (AGENTS.md 2.5, owner queue Q27): cancelling now could cancel a paid order.
    const open = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM payment_attempts
           WHERE order_id = ${order.id} AND state IN ('pending', 'in_flight', 'unknown')`,
    );
    if ((open.rows[0]?.n ?? 0) > 0)
      return { orderId: order.id, changed: false, from: order.status };
  }
  if (!canTransition(order.status, 'cancelled')) {
    throw new OrderNotCancellableError(`the order is ${order.status}`);
  }
  const releaseReason = input.expiredOnly === true ? 'expired' : 'cancelled';

  const reservations = await liveReservations(tx, order.id);
  const [redemption] = await tx
    .select({ promoCodeId: promoCodeRedemptions.promoCodeId })
    .from(promoCodeRedemptions)
    .where(
      and(eq(promoCodeRedemptions.orderId, order.id), eq(promoCodeRedemptions.state, 'consumed')),
    );
  const openAttempts = await tx
    .select({ id: paymentAttempts.id, status: paymentAttempts.status })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, order.id),
        inArray(paymentAttempts.state, ['pending', 'in_flight']),
        inArray(paymentAttempts.status, ['pending', 'authorized']),
      ),
    );
  // One call, ADR-22 order: payment_attempts (5), promo_codes (6), product_variants (8).
  await acquireLocks(tx, {
    payment_attempts: openAttempts.map((a) => a.id),
    ...(redemption === undefined ? {} : { promo_codes: [redemption.promoCodeId] }),
    product_variants: reservations.map((r) => r.variantId),
  });

  for (const reservation of reservations) {
    const quantity = await closeReservation(tx, reservation.id, releaseReason);
    if (quantity === null) continue;
    const released = await tx.execute(
      sql`UPDATE product_variants SET reserved_quantity = reserved_quantity - ${quantity}
           WHERE id = ${reservation.variantId} AND reserved_quantity >= ${quantity}
          RETURNING id`,
    );
    if (released.rows.length === 0) {
      throw new StockDriftError(`reserved counter does not cover reservation ${reservation.id}`);
    }
  }

  if (redemption !== undefined) {
    const freed = await tx.execute(
      sql`UPDATE promo_code_redemptions SET state = 'released', released_at = now()
           WHERE order_id = ${order.id} AND state = 'consumed'
          RETURNING id`,
    );
    if (freed.rows.length > 0) {
      const given = await tx.execute(
        sql`UPDATE promo_codes SET uses_count = uses_count - 1
             WHERE id = ${redemption.promoCodeId} AND uses_count > 0
            RETURNING id`,
      );
      if (given.rows.length === 0) throw new StockDriftError('promo uses_count is already zero');
    }
  }

  // Open invoices are closed locally. A late payment on one is still credited and raises the
  // late-payment alert (the order is cancelled); cancelling at the provider is a follow-up.
  if (openAttempts.length > 0) {
    await tx
      .update(paymentAttempts)
      .set({ state: 'failed', status: 'failed', failureReason: 'order cancelled' })
      .where(
        inArray(
          paymentAttempts.id,
          openAttempts.map((a) => a.id),
        ),
      );
  }

  await tx
    .update(orders)
    .set({
      status: 'cancelled',
      cancelledAt: sql`now()`,
      ...(input.expiredOnly === true ? { paymentStatus: 'expired' as const } : {}),
    })
    .where(eq(orders.id, order.id));
  await recordTransition(tx, order, 'cancelled', input.source, input.reason, input);
  if (input.expiredOnly === true) {
    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      fromStatus: order.paymentStatus,
      toStatus: 'expired',
      field: 'payment_status',
      source: input.source,
      comment: input.reason,
    });
  }

  // Money to give back: what was captured minus what was already refunded.
  const refundable = order.capturedTotal - (await heldRefundTotal(tx, order.id));
  const heldAuthorization = openAttempts.some((a) => a.status === 'authorized');
  if (refundable > 0 || heldAuthorization) {
    // The refund (or the release of a card hold at the provider) is its own operation and a
    // human or the refund flow must start it. Announced through the outbox, once.
    await tx
      .insert(outbox)
      .values({
        topic: 'alert.refund-due',
        payload: { orderId: order.id, refundable, heldAuthorization },
        dedupKey: `refund-due:${order.id}`,
      })
      .onConflictDoNothing();
  }
  return { orderId: order.id, changed: true, from: order.status, refundable, heldAuthorization };
}
