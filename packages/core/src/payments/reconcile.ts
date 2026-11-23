/**
 * `payments:reconcile-open` (ADR-4 source 2, owner queue Q17 and Q27): asks the provider for the
 * status of every attempt that is still open (`pending`, `in_flight`, `unknown`) and applies the
 * answer through the SAME code path as a verified webhook (`applyPaymentWebhook`: binding checks,
 * one transaction, one lock order, one `payment_events` row per distinct answer).
 *
 * It runs BEFORE any automatic cancellation: the expiry job skips orders with an `in_flight` or
 * `unknown` attempt, so an unpaid-looking order whose webhook never arrived is settled here first.
 *
 * What it can and cannot know:
 *  - WayForPay looks a payment up by OUR reference, so even an attempt whose create answer was
 *    lost is asked about; "no such order" (404) means the invoice was never created.
 *  - Mono looks up by its own invoice id. An attempt without one cannot be asked; it is closed
 *    only once its invoice has certainly expired (validity plus a margin), because nothing can be
 *    paid on it any more. Until then the webhook (which carries our reference) resolves it.
 * Nothing here ever creates an invoice or retries a refund.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { outbox, paymentAttempts } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { PaymentProviderError, type WebhookResult } from '@store/payments/types';

import { applyPaymentWebhook } from './apply-webhook.ts';
import { recordAttemptRefused } from './attempts.ts';
import type { ProviderMap } from './refunds.ts';

/** Do not ask about an attempt younger than this: its own provider call may still be running. */
const MIN_AGE_SECONDS = 120;
/** An invoice that never reached us is dead this long after its validity ended. */
const EXPIRY_MARGIN_MINUTES = 30;
/** An attempt that stays unresolved for this long is a human's problem. */
const ALERT_AFTER_HOURS = 24;

export interface ReconcileResult {
  checked: number;
  applied: number;
  closed: number;
  providerErrors: number;
  unaskable: number;
  alerts: number;
}

export interface ReconcileDeps {
  db: Reader & { transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };
  providers: ProviderMap;
  batch?: number;
}

type Candidate = {
  id: string;
  provider: 'mono' | 'wayforpay' | 'cod' | 'bank_transfer' | 'gift_card';
  localReference: string;
  externalId: string | null;
  state: 'pending' | 'in_flight' | 'unknown';
  overdue: boolean;
  alertDue: boolean;
};

async function candidates(db: Reader, limit: number): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: paymentAttempts.id,
      provider: paymentAttempts.provider,
      localReference: paymentAttempts.localReference,
      externalId: paymentAttempts.externalId,
      state: paymentAttempts.state,
      overdue: sql<boolean>`${paymentAttempts.expiresAt} IS NOT NULL
        AND ${paymentAttempts.expiresAt} + make_interval(mins => ${EXPIRY_MARGIN_MINUTES}) < now()`,
      alertDue: sql<boolean>`${paymentAttempts.createdAt} + make_interval(hours => ${ALERT_AFTER_HOURS}) < now()`,
    })
    .from(paymentAttempts)
    .where(
      and(
        inArray(paymentAttempts.state, ['pending', 'in_flight', 'unknown']),
        eq(paymentAttempts.status, 'pending'),
        inArray(paymentAttempts.provider, ['mono', 'wayforpay']),
        sql`${paymentAttempts.createdAt} < now() - make_interval(secs => ${MIN_AGE_SECONDS})`,
      ),
    )
    .orderBy(asc(paymentAttempts.createdAt))
    .limit(limit);
  return rows.filter(
    (row): row is Candidate => row.state !== 'succeeded' && row.state !== 'failed',
  );
}

async function raiseAlert(db: ReconcileDeps['db'], attempt: Candidate): Promise<boolean> {
  const inserted = await db.transaction(
    async (tx) =>
      await tx
        .insert(outbox)
        .values({
          topic: 'alert.attempt-unresolved',
          // Ids only: no buyer data in an alert payload.
          payload: { attemptId: attempt.id, provider: attempt.provider },
          dedupKey: `attempt-unresolved:${attempt.id}`,
        })
        .onConflictDoNothing()
        .returning({ id: outbox.id }),
  );
  return inserted.length > 0;
}

export async function reconcileOpenAttempts(deps: ReconcileDeps): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    checked: 0,
    applied: 0,
    closed: 0,
    providerErrors: 0,
    unaskable: 0,
    alerts: 0,
  };
  for (const attempt of await candidates(deps.db, deps.batch ?? 50)) {
    const adapter =
      attempt.provider === 'mono' || attempt.provider === 'wayforpay'
        ? deps.providers[attempt.provider]
        : undefined;
    if (adapter === undefined) {
      result.unaskable += 1;
      continue;
    }
    const key =
      adapter.statusLookupKey === 'localReference' ? attempt.localReference : attempt.externalId;
    if (key === null) {
      // Nothing to ask with (Mono, the create answer was lost).
      result.unaskable += 1;
      if (attempt.overdue) {
        const closed = await deps.db.transaction(
          async (tx) =>
            await recordAttemptRefused(tx, {
              attemptId: attempt.id,
              reason: 'invoice never confirmed and its validity has passed',
              status: 'expired',
            }),
        );
        if (closed) result.closed += 1;
      } else if (attempt.alertDue && (await raiseAlert(deps.db, attempt))) result.alerts += 1;
      continue;
    }
    result.checked += 1;
    try {
      const status = await adapter.getPaymentStatus(key);
      if (status.localReference !== null && status.localReference !== attempt.localReference) {
        result.providerErrors += 1;
        continue;
      }
      const message: WebhookResult = {
        messageKey: `reconcile:${status.externalId}:${status.status}:${String(status.capturedAmount)}`,
        externalId: status.externalId,
        localReference: attempt.localReference,
        eventType: 'status.lookup',
        status: status.status,
        amount: status.amount,
        capturedAmount: status.capturedAmount,
        currency: status.currency,
        stateVersion: status.stateVersion,
        failureReason: status.failureReason,
        rawPayload: {
          source: 'getPaymentStatus',
          status: status.status,
          amount: status.amount,
          capturedAmount: status.capturedAmount,
        },
      };
      const outcome = await deps.db.transaction(async (tx) => {
        const applied = await applyPaymentWebhook(
          tx,
          adapter.code,
          message,
          `reconcile:${adapter.code}`,
        );
        // The invoice exists (the provider answered about it): it is no longer "unknown".
        await tx
          .update(paymentAttempts)
          .set({ state: 'in_flight' })
          .where(
            and(
              eq(paymentAttempts.id, attempt.id),
              inArray(paymentAttempts.state, ['pending', 'unknown']),
              eq(paymentAttempts.status, 'pending'),
            ),
          );
        return applied;
      });
      if (outcome.kind === 'applied') result.applied += 1;
    } catch (error) {
      if (error instanceof PaymentProviderError && error.status === 404) {
        // The provider has no such payment: the invoice was never created.
        const closed = await deps.db.transaction(
          async (tx) =>
            await recordAttemptRefused(tx, {
              attemptId: attempt.id,
              reason: 'the provider has no such payment',
            }),
        );
        if (closed) result.closed += 1;
        continue;
      }
      result.providerErrors += 1;
      if (attempt.alertDue && (await raiseAlert(deps.db, attempt))) result.alerts += 1;
    }
  }
  return result;
}
