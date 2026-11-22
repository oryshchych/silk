/**
 * Payment attempts (ADR-11). An attempt exists in the database, with its own
 * immutable `local_reference`, BEFORE the provider is called: if the answer is
 * lost we know what to ask, and we never open a second invoice.
 *
 * createPaymentAttempt (transaction 1) -> provider.createPayment (no
 * transaction held open) -> recordAttemptResult (transaction 2).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { orders, paymentAttempts, stockReservations } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import type { CreatePaymentResult } from '@store/payments/types';

import { AttemptStillOpenError, AttemptUnresolvedError, OrderNotPayableError } from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';

const ATTEMPT_VALIDITY_MINUTES = 30;

export interface NewAttempt {
  attemptId: string;
  attemptNumber: number;
  localReference: string;
  amount: number;
  orderNumber: string;
}

export async function createPaymentAttempt(
  tx: Tx,
  input: { orderId: string; provider: 'mono' | 'wayforpay' },
): Promise<NewAttempt> {
  await acquireLocks(tx, { orders: [input.orderId] });
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (order === undefined) throw new OrderNotPayableError('no such order');
  if (order.status === 'cancelled') throw new OrderNotPayableError('the order is cancelled');
  if (order.paymentStatus === 'paid' || order.capturedTotal > 0) {
    throw new OrderNotPayableError('the order is already paid');
  }

  const live = await tx
    .select({ id: stockReservations.id })
    .from(stockReservations)
    .where(
      and(eq(stockReservations.orderId, order.id), sql`${stockReservations.releasedAt} IS NULL`),
    );
  if (live.length === 0) throw new OrderNotPayableError('the reservation is gone');

  const open = await tx
    .select({
      id: paymentAttempts.id,
      state: paymentAttempts.state,
      status: paymentAttempts.status,
      hasInvoice: sql<boolean>`${paymentAttempts.externalId} IS NOT NULL`,
      isExpired: sql<boolean>`${paymentAttempts.expiresAt} IS NOT NULL AND ${paymentAttempts.expiresAt} < now()`,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, order.id),
        inArray(paymentAttempts.state, ['pending', 'in_flight', 'unknown']),
      ),
    );
  // `unknown` means money may have moved: reconcile first, never open another invoice.
  if (open.some((attempt) => attempt.state === 'unknown')) throw new AttemptUnresolvedError();
  // A live invoice (it exists at the provider, is not expired, or holds money) cannot be
  // replaced: the buyer could pay both. Cancelling an invoice at the provider is a follow-up
  // (NOTES.md), so until it exists the previous one must expire first.
  if (
    open.some(
      (attempt) => attempt.status === 'authorized' || (attempt.hasInvoice && !attempt.isExpired),
    )
  ) {
    throw new AttemptStillOpenError();
  }
  if (open.length > 0) {
    // Superseded: never reached the provider, or its invoice has expired. A late payment on
    // it is still credited, because captured_total is the sum over attempts.
    await tx
      .update(paymentAttempts)
      .set({ state: 'failed', status: 'failed', failureReason: 'superseded' })
      .where(
        inArray(
          paymentAttempts.id,
          open.map((attempt) => attempt.id),
        ),
      );
  }

  const [last] = await tx
    .select({ n: sql<number>`coalesce(max(${paymentAttempts.attemptNumber}), 0)::int` })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, order.id));
  const attemptNumber = (last?.n ?? 0) + 1;

  const [attempt] = await tx
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      attemptNumber,
      provider: input.provider,
      amount: order.total,
      expiresAt: sql`now() + make_interval(mins => ${ATTEMPT_VALIDITY_MINUTES})`,
    })
    .returning({ id: paymentAttempts.id, localReference: paymentAttempts.localReference });
  if (attempt === undefined) throw new Error('attempt insert returned no row');

  await tx
    .update(orders)
    .set({
      currentPaymentAttemptId: attempt.id,
      paymentProvider: input.provider,
      providerPaymentId: null,
    })
    .where(eq(orders.id, order.id));

  return {
    attemptId: attempt.id,
    attemptNumber,
    localReference: attempt.localReference,
    amount: order.total,
    orderNumber: order.orderNumber,
  };
}

/**
 * Stores the provider's answer. A webhook may have settled the attempt before
 * this runs (it can beat the redirect), so state moves forward from `pending`
 * only and the external id is filled in, never overwritten.
 */
export async function recordAttemptResult(
  tx: Tx,
  input: { attemptId: string; result: CreatePaymentResult },
): Promise<void> {
  const [probe] = await tx
    .select({ orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, input.attemptId));
  if (probe === undefined) throw new Error(`unknown payment attempt ${input.attemptId}`);
  await acquireLocks(tx, { orders: [probe.orderId], payment_attempts: [input.attemptId] });

  const { result } = input;
  if (result.ok) {
    await tx
      .update(paymentAttempts)
      .set({
        externalId: sql`coalesce(${paymentAttempts.externalId}, ${result.externalId})`,
        redirectUrl: result.redirectUrl,
        state: sql`case when ${paymentAttempts.state} = 'pending' then 'in_flight'::operation_state else ${paymentAttempts.state} end`,
      })
      .where(eq(paymentAttempts.id, input.attemptId));
    await tx
      .update(orders)
      .set({ providerPaymentId: sql`coalesce(${orders.providerPaymentId}, ${result.externalId})` })
      .where(eq(orders.id, probe.orderId));
    return;
  }
  await tx
    .update(paymentAttempts)
    .set({
      state: sql`case when ${paymentAttempts.state} = 'pending' then 'unknown'::operation_state else ${paymentAttempts.state} end`,
    })
    .where(eq(paymentAttempts.id, input.attemptId));
}
