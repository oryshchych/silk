/**
 * Applies a VERIFIED payment webhook (ADR-4, docs/architecture/05-payment-flow.md).
 * The caller has already checked the signature on the raw bytes; nothing
 * unverified reaches this function (unverified messages go to the quarantine).
 *
 * One transaction covers the event, the attempt, the order's financial state,
 * history, audit and outbox. Idempotent RECEIPT is not idempotent APPLICATION:
 * a duplicate is dropped only once `payment_events.applied_at` is set, and the
 * event is inserted inside the same transaction that applies it, so a crash in
 * between leaves nothing behind and the redelivery applies it.
 *
 * Lock order (ADR-22): orders (3), then payment_attempts (5). Stock is NOT
 * touched here: payment only lifts the reservation's expiry (ADR-18).
 */
import { and, eq, ne, sql } from 'drizzle-orm';

import {
  auditLog,
  orderStatusHistory,
  orders,
  outbox,
  paymentAttempts,
  paymentEvents,
  stockReservations,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';
import type { PaymentStatus, WebhookResult } from '@store/payments/types';

import { enqueueSaleReceipt } from '../fiscal/receipts.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';

export type WebhookOutcome =
  /** The attempt and order changed. */
  | { kind: 'applied'; orderId: string }
  /** Recorded, but it is older than a confirmed state or an illegal transition: no change. */
  | { kind: 'ignored'; orderId: string; reason: string }
  /** The message was applied before. */
  | { kind: 'duplicate'; orderId: string }
  /** Authentic, but it contradicts the attempt (amount, currency, provider). Stored with an error. */
  | { kind: 'rejected'; orderId: string; reason: string }
  /** Authentic, but names no attempt of ours. The caller quarantines it. */
  | { kind: 'unmatched' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which attempt status may follow which. Anything else is recorded and ignored. */
const ALLOWED: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ['authorized', 'paid', 'failed', 'expired'],
  authorized: ['paid', 'failed', 'expired'],
  // A failed or expired invoice can still be paid late (the buyer opened an old page).
  failed: ['paid'],
  expired: ['paid'],
  paid: [],
  // Refund states are driven by refund_operations (ADR-4 source 4), never by a webhook.
  refunded: [],
  partially_refunded: [],
};

type Attempt = typeof paymentAttempts.$inferSelect;
type Order = typeof orders.$inferSelect;

/**
 * Binding of an authentic message to the attempt (ADR-4): provider, currency,
 * amount, invoice identity, and that a `paid` message captured EXACTLY the
 * attempt amount. A short or zero capture is not a payment: it is stored with
 * an error and alerted, never credited.
 */
async function bindingProblem(
  tx: Tx,
  attempt: Attempt,
  provider: string,
  result: WebhookResult,
): Promise<string | null> {
  if (attempt.provider !== provider) return 'provider does not match the attempt';
  if (result.currency !== attempt.currency) return 'currency does not match the attempt';
  if (result.amount !== attempt.amount) return 'amount does not match the attempt';
  if (attempt.externalId !== null && attempt.externalId !== result.externalId) {
    return 'external id does not match the attempt';
  }
  if (result.status === 'paid' && result.capturedAmount !== attempt.amount) {
    return 'captured amount differs from the attempt amount';
  }
  const clash = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, attempt.provider),
        eq(paymentAttempts.externalId, result.externalId),
        ne(paymentAttempts.id, attempt.id),
      ),
    );
  if (clash.length > 0) return 'external id belongs to another attempt';
  return null;
}

/** Order-level payment status derived from ALL attempts (an order may have several). */
async function derivePaymentStatus(tx: Tx, order: Order): Promise<PaymentStatus> {
  if (order.paymentStatus === 'refunded' || order.paymentStatus === 'partially_refunded') {
    return order.paymentStatus;
  }
  const attempts = await tx
    .select({ status: paymentAttempts.status })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, order.id));
  const has = (status: PaymentStatus): boolean => attempts.some((a) => a.status === status);
  if (has('paid')) return 'paid';
  if (has('authorized')) return 'authorized';
  if (has('pending')) return 'pending';
  return has('expired') && !has('failed') ? 'expired' : 'failed';
}

/**
 * `source` names the confirmed server source in history and audit: a verified webhook (default)
 * or an active status lookup (`reconcile:<provider>`, ADR-4 source 2). Both go through the same
 * checks and the same transaction.
 */
export async function applyPaymentWebhook(
  tx: Tx,
  provider: 'mono' | 'wayforpay',
  result: WebhookResult,
  source: string = `webhook:${provider}`,
): Promise<WebhookOutcome> {
  if (!UUID.test(result.localReference)) return { kind: 'unmatched' };

  // Unlocked read, only to learn which order to lock.
  const [probe] = await tx
    .select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.localReference, result.localReference));
  if (probe === undefined) return { kind: 'unmatched' };

  await acquireLocks(tx, { orders: [probe.orderId], payment_attempts: [probe.id] });
  const [attempt] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, probe.id));
  const [order] = await tx.select().from(orders).where(eq(orders.id, probe.orderId));
  if (attempt === undefined || order === undefined) return { kind: 'unmatched' };

  const problem = await bindingProblem(tx, attempt, provider, result);

  const inserted = await tx
    .insert(paymentEvents)
    .values({
      orderId: order.id,
      paymentAttemptId: attempt.id,
      provider,
      messageKey: result.messageKey,
      stateVersion: result.stateVersion,
      eventType: result.eventType,
      mappedStatus: result.status,
      amount: result.amount,
      currency: result.currency,
      rawPayload: result.rawPayload,
      error: problem,
    })
    .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.messageKey] })
    .returning({ id: paymentEvents.id });

  let eventId = inserted[0]?.id;
  if (eventId === undefined) {
    const [existing] = await tx
      .select({ id: paymentEvents.id, appliedAt: paymentEvents.appliedAt })
      .from(paymentEvents)
      .where(
        and(eq(paymentEvents.provider, provider), eq(paymentEvents.messageKey, result.messageKey)),
      );
    if (existing === undefined) throw new Error('payment event vanished after a conflict');
    if (existing.appliedAt !== null) return { kind: 'duplicate', orderId: order.id };
    eventId = existing.id;
  }

  if (problem !== null) {
    // The provider is answered 200 (a retry cannot fix an inconsistent message), so a human
    // must hear about it: the buyer may really have paid.
    await tx
      .insert(outbox)
      .values({
        topic: 'alert.payment-mismatch',
        payload: { orderId: order.id, attemptId: attempt.id, reason: problem },
        dedupKey: `payment-mismatch:${eventId}`,
      })
      .onConflictDoNothing();
    return { kind: 'rejected', orderId: order.id, reason: problem };
  }

  const markApplied = async (note: string | null): Promise<void> => {
    await tx
      .update(paymentEvents)
      .set({ appliedAt: sql`now()`, error: note })
      .where(eq(paymentEvents.id, eventId));
  };

  // A message older than one that CONFIRMED the attempt's current status is stale. Only such
  // events count: ignored or rejected ones (error set) must not make an older, genuine
  // message look stale. A `paid` message is never dropped as stale: it is real money.
  if (result.stateVersion !== null && result.status !== 'paid') {
    const newer = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM payment_events
           WHERE payment_attempt_id = ${attempt.id}
             AND applied_at IS NOT NULL
             AND error IS NULL
             AND mapped_status = ${attempt.status}::payment_status
             AND state_version > ${result.stateVersion.toISOString()}::timestamptz`,
    );
    if ((newer.rows[0]?.n ?? 0) > 0) {
      await markApplied('stale: a newer state was already applied');
      return { kind: 'ignored', orderId: order.id, reason: 'stale' };
    }
  }

  const from = attempt.status;
  // A reversed HOLD means the hold was released: the attempt failed, nothing was captured.
  const to: PaymentStatus =
    from === 'authorized' && result.status === 'refunded' ? 'failed' : result.status;
  // `paid` to `paid` with a different capture is NOT applied from a webhook; adjusted
  // captures are reconciled with getPaymentStatus (NOTES.md).
  if (to === from) {
    await markApplied(null);
    await fillExternalId(tx, attempt, result);
    return { kind: 'ignored', orderId: order.id, reason: 'no change' };
  }
  if (!ALLOWED[from].includes(to)) {
    await markApplied(`transition ${from} -> ${to} not allowed`);
    return { kind: 'ignored', orderId: order.id, reason: 'transition not allowed' };
  }

  await tx
    .update(paymentAttempts)
    .set({
      status: to,
      state: to === 'authorized' ? 'in_flight' : to === 'paid' ? 'succeeded' : 'failed',
      capturedAmount: to === 'paid' ? result.capturedAmount : attempt.capturedAmount,
      failureReason: result.failureReason,
      completedAt: to === 'authorized' ? null : sql`now()`,
      externalId: sql`coalesce(${paymentAttempts.externalId}, ${result.externalId})`,
    })
    .where(eq(paymentAttempts.id, attempt.id));

  await settleOrder(tx, source, order, to, attempt.id);
  await markApplied(null);
  return { kind: 'applied', orderId: order.id };
}

async function fillExternalId(tx: Tx, attempt: Attempt, result: WebhookResult): Promise<void> {
  if (attempt.externalId !== null) return;
  await tx
    .update(paymentAttempts)
    .set({ externalId: result.externalId })
    .where(eq(paymentAttempts.id, attempt.id));
}

async function settleOrder(
  tx: Tx,
  source: string,
  order: Order,
  attemptStatus: PaymentStatus,
  attemptId: string,
): Promise<void> {
  const next = await derivePaymentStatus(tx, order);
  let isLate = order.status === 'cancelled' || order.paymentStatus === 'expired';

  const [updated] = await tx
    .update(orders)
    .set({
      paymentStatus: next,
      // The money actually captured across ALL attempts (derived, never typed by hand).
      capturedTotal: sql`(SELECT coalesce(sum(captured_amount), 0)::int
                            FROM payment_attempts WHERE order_id = ${order.id})`,
      ...(attemptStatus === 'paid' ? { paidAt: sql`coalesce(${orders.paidAt}, now())` } : {}),
    })
    .where(eq(orders.id, order.id))
    .returning({ captured: orders.capturedTotal, total: orders.total });

  if (attemptStatus === 'paid' && !isLate) {
    // ADR-18: payment lifts the expiry and keeps the reservation until shipping.
    // stock_quantity and reserved_quantity are not touched.
    const lifted = await tx
      .update(stockReservations)
      .set({ expiresAt: null })
      .where(
        and(eq(stockReservations.orderId, order.id), sql`${stockReservations.releasedAt} IS NULL`),
      )
      .returning({ id: stockReservations.id });
    // No live reservation: the goods may already belong to someone else. A human decides.
    if (lifted.length === 0) isLate = true;
  }

  if (next !== order.paymentStatus) {
    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      fromStatus: order.paymentStatus,
      toStatus: next,
      field: 'payment_status',
      source,
      comment:
        isLate && attemptStatus === 'paid' ? 'late payment after cancellation or expiry' : null,
    });
    await tx.insert(auditLog).values({
      action: 'transition',
      entity: 'order',
      entityId: order.id,
      diff: {
        source,
        field: 'payment_status',
        from: order.paymentStatus,
        to: next,
      },
    });
  }

  if (attemptStatus === 'failed' || attemptStatus === 'expired') {
    // The buyer hears that this payment failed (once per attempt) while the order can still be
    // paid; a cancelled order cannot, so it gets no "try again".
    if (order.status !== 'cancelled' && (next === 'failed' || next === 'expired')) {
      await tx
        .insert(outbox)
        .values({
          topic: 'email.payment-failed',
          payload: { orderId: order.id },
          dedupKey: `payment-failed:${attemptId}`,
        })
        .onConflictDoNothing();
    }
    return;
  }
  if (attemptStatus !== 'paid') return;

  // ADR-16: the receipt is a SEPARATE queue job written in this transaction, never a call made
  // from here. A late payment is money received too, so it gets its receipt as well.
  await enqueueSaleReceipt(tx, { orderId: order.id, paymentForm: 'card' });

  // Mail and manager alerts leave through the outbox, never from the request. The buyer
  // gets ONE confirmation per order, however many attempts end up paid.
  await tx
    .insert(outbox)
    .values({
      topic: isLate ? 'alert.late-payment' : 'email.payment-received',
      payload: { orderId: order.id },
      dedupKey: `${isLate ? 'late-payment' : 'payment-received'}:${order.id}`,
    })
    .onConflictDoNothing();
  if (updated !== undefined && updated.captured > updated.total) {
    // Two attempts were both paid (e.g. the buyer opened two invoices): a manual refund is due.
    await tx
      .insert(outbox)
      .values({
        topic: 'alert.double-payment',
        payload: { orderId: order.id, captured: updated.captured, total: updated.total },
        dedupKey: `double-payment:${order.id}`,
      })
      .onConflictDoNothing();
  }
}
