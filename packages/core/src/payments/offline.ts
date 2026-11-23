/**
 * Cash on delivery and bank transfer (ADR-4 source 3, owner queue Q16). Neither has a webhook:
 * a MANAGER action is the confirmed source, with evidence and an audit row.
 *
 *  - COD: `confirmCodOrder` sets `orders.status = confirmed` and lifts the reservation expiry
 *    (ADR-18). Nothing is captured: `delivered` does not mean the money arrived, the carrier's
 *    remittance is a separate fact.
 *  - Transfer: `confirmTransferReceived` records the received money as a `bank_transfer` attempt
 *    (so `captured_total` stays the sum over attempts) keyed by the BANK REFERENCE, which is
 *    unique per provider: the same bank line cannot credit two orders or one order twice. The
 *    amount must equal the order total; anything else is refused for a human to sort out.
 *
 * Lock order (ADR-22): orders (3), then payment_attempts (5). Both are idempotent.
 */
import { and, eq, sql } from 'drizzle-orm';

import {
  auditLog,
  orderStatusHistory,
  orders,
  outbox,
  paymentAttempts,
  stockReservations,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { OrderNotConfirmableError, TransferAmountMismatchError } from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';

type Order = typeof orders.$inferSelect;

export interface ConfirmResult {
  orderId: string;
  /** False when an earlier call already did it. */
  changed: boolean;
}

async function lockedOrder(tx: Tx, orderId: string): Promise<Order> {
  await acquireLocks(tx, { orders: [orderId] });
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (order === undefined) throw new OrderNotConfirmableError('no such order');
  return order;
}

/** The reservation must be live: confirming an order whose goods were released sells nothing. */
async function liftReservationExpiry(tx: Tx, orderId: string): Promise<boolean> {
  const lifted = await tx
    .update(stockReservations)
    .set({ expiresAt: null })
    .where(
      and(eq(stockReservations.orderId, orderId), sql`${stockReservations.releasedAt} IS NULL`),
    )
    .returning({ id: stockReservations.id });
  return lifted.length > 0;
}

async function recordStatusChange(
  tx: Tx,
  order: Order,
  field: 'status' | 'payment_status',
  to: string,
  source: string,
  comment: string | null,
): Promise<void> {
  await tx.insert(orderStatusHistory).values({
    orderId: order.id,
    fromStatus: field === 'status' ? order.status : order.paymentStatus,
    toStatus: to,
    field,
    source,
    comment,
  });
  await tx.insert(auditLog).values({
    action: 'transition',
    entity: 'order',
    entityId: order.id,
    diff: { source, field, to },
  });
}

export async function confirmCodOrder(
  tx: Tx,
  input: { orderId: string; actor: string },
): Promise<ConfirmResult> {
  const order = await lockedOrder(tx, input.orderId);
  if (order.paymentProvider !== 'cod') throw new OrderNotConfirmableError('not a COD order');
  if (order.status === 'confirmed' || order.status === 'processing') {
    return { orderId: order.id, changed: false };
  }
  if (order.status !== 'pending')
    throw new OrderNotConfirmableError(`the order is ${order.status}`);
  if (!(await liftReservationExpiry(tx, order.id))) {
    throw new OrderNotConfirmableError('the reservation is gone');
  }
  await tx.update(orders).set({ status: 'confirmed' }).where(eq(orders.id, order.id));
  await recordStatusChange(
    tx,
    order,
    'status',
    'confirmed',
    `manager:${input.actor}`,
    'COD confirmed',
  );
  return { orderId: order.id, changed: true };
}

export async function confirmTransferReceived(
  tx: Tx,
  input: { orderId: string; actor: string; bankReference: string; receivedAmount: number },
): Promise<ConfirmResult> {
  if (input.bankReference.trim() === '' || input.bankReference.length > 128) {
    throw new OrderNotConfirmableError('a bank reference is required');
  }
  const order = await lockedOrder(tx, input.orderId);
  if (order.paymentProvider !== 'bank_transfer') {
    throw new OrderNotConfirmableError('not a bank transfer order');
  }
  const [existing] = await tx
    .select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, 'bank_transfer'),
        eq(paymentAttempts.externalId, input.bankReference),
      ),
    );
  if (existing !== undefined) {
    // The same bank line again: a repeat for this order is a no-op, for another order a refusal.
    if (existing.orderId === order.id) return { orderId: order.id, changed: false };
    throw new OrderNotConfirmableError('this bank reference already credited another order');
  }
  if (order.paymentStatus === 'paid') return { orderId: order.id, changed: false };
  if (order.status === 'cancelled' || order.status === 'shipped' || order.status === 'delivered') {
    throw new OrderNotConfirmableError(`the order is ${order.status}`);
  }
  if (input.receivedAmount !== order.total) throw new TransferAmountMismatchError();

  const [last] = await tx
    .select({ n: sql<number>`coalesce(max(${paymentAttempts.attemptNumber}), 0)::int` })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, order.id));
  const inserted = await tx
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      attemptNumber: (last?.n ?? 0) + 1,
      provider: 'bank_transfer',
      externalId: input.bankReference,
      state: 'succeeded',
      status: 'paid',
      amount: order.total,
      capturedAmount: order.total,
      completedAt: sql`now()`,
    })
    .returning({ id: paymentAttempts.id });
  const attemptId = inserted[0]?.id;
  if (attemptId === undefined) throw new Error('transfer attempt insert returned no row');

  const reserved = await liftReservationExpiry(tx, order.id);
  await tx
    .update(orders)
    .set({
      paymentStatus: 'paid',
      // Derived from the attempts, never typed by hand.
      capturedTotal: sql`(SELECT coalesce(sum(captured_amount), 0)::int
                            FROM payment_attempts WHERE order_id = ${order.id})`,
      paidAt: sql`coalesce(${orders.paidAt}, now())`,
      currentPaymentAttemptId: attemptId,
      ...(reserved && order.status === 'pending' ? { status: 'confirmed' as const } : {}),
    })
    .where(eq(orders.id, order.id));
  const source = `manager:${input.actor}`;
  await recordStatusChange(tx, order, 'payment_status', 'paid', source, 'bank transfer received');
  if (reserved && order.status === 'pending') {
    await recordStatusChange(tx, order, 'status', 'confirmed', source, 'bank transfer received');
  }
  // No live reservation: the money is a fact, the goods may be gone. A human decides.
  await tx
    .insert(outbox)
    .values({
      topic: reserved ? 'email.payment-received' : 'alert.late-payment',
      payload: { orderId: order.id },
      dedupKey: `${reserved ? 'payment-received' : 'late-payment'}:${order.id}`,
    })
    .onConflictDoNothing();
  return { orderId: order.id, changed: true };
}
