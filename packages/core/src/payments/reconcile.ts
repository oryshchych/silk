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
 *    lost is asked about. "No such order" (404) is NOT proof that no invoice exists: the invoice
 *    page of a created invoice can be payable while WayForPay still knows no payment for it. It
 *    closes an attempt only when we never had a confirmed invoice (no external id) and the
 *    invoice's validity plus a margin has passed; for an attempt with an invoice it is a provider
 *    error and an alert.
 *  - Mono looks up by its own invoice id. An attempt without one cannot be asked; it is closed
 *    only once its invoice has certainly expired (validity plus a margin), because nothing can be
 *    paid on it any more. Until then the webhook (which carries our reference) resolves it.
 * Nothing here ever creates an invoice or retries a refund.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { outbox, paymentAttempts } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import {
  PaymentProviderError,
  type PaymentProvider,
  type WebhookResult,
} from '@store/payments/types';

import { applyPaymentWebhook } from './apply-webhook.ts';
import { recordAttemptRefused } from './attempts.ts';
import type { ProviderMap } from './refunds.ts';

/** Do not ask about an attempt younger than this: its own provider call may still be running. */
const MIN_AGE_SECONDS = 120;
/** An invoice that never reached us is dead this long after its validity ended. */
const EXPIRY_MARGIN_MINUTES = 30;
/** An attempt that stays unresolved for this long is a human's problem. */
const ALERT_AFTER_HOURS = 24;
/** An authorized (held) payment that is not settled this long after it was created needs a person. */
const AUTHORIZED_ALERT_HOURS = 6;
/** Attempts asked about per page; a run walks ALL open attempts page by page (a cursor). */
const PAGE_SIZE = 50;
/** Hard bound on one run, so a huge backlog cannot hold the job for hours. */
const MAX_PER_RUN = 1000;

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
  status: 'pending' | 'authorized';
  overdue: boolean;
  alertDue: boolean;
  authorizedOld: boolean;
  /** Keyset cursor: created_at as text (microseconds survive) and the id. */
  cursorAt: string;
};

/**
 * One page of open attempts after the cursor. `pending` AND `authorized`: a held payment whose
 * final webhook was lost (WayForPay WaitingAuthComplete, Mono hold) is still open money.
 */
async function candidates(
  db: Reader,
  after: { at: string; id: string } | null,
  limit: number,
): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: paymentAttempts.id,
      provider: paymentAttempts.provider,
      localReference: paymentAttempts.localReference,
      externalId: paymentAttempts.externalId,
      status: paymentAttempts.status,
      overdue: sql<boolean>`${paymentAttempts.expiresAt} IS NOT NULL
        AND ${paymentAttempts.expiresAt} + make_interval(mins => ${EXPIRY_MARGIN_MINUTES}) < now()`,
      alertDue: sql<boolean>`${paymentAttempts.createdAt} + make_interval(hours => ${ALERT_AFTER_HOURS}) < now()`,
      authorizedOld: sql<boolean>`${paymentAttempts.status} = 'authorized'
        AND ${paymentAttempts.createdAt} + make_interval(hours => ${AUTHORIZED_ALERT_HOURS}) < now()`,
      cursorAt: sql<string>`${paymentAttempts.createdAt}::text`,
    })
    .from(paymentAttempts)
    .where(
      and(
        inArray(paymentAttempts.state, ['pending', 'in_flight', 'unknown']),
        inArray(paymentAttempts.status, ['pending', 'authorized']),
        inArray(paymentAttempts.provider, ['mono', 'wayforpay']),
        sql`${paymentAttempts.createdAt} < now() - make_interval(secs => ${MIN_AGE_SECONDS})`,
        after === null
          ? sql`true`
          : sql`(${paymentAttempts.createdAt}, ${paymentAttempts.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`,
      ),
    )
    .orderBy(asc(paymentAttempts.createdAt), asc(paymentAttempts.id))
    .limit(limit);
  return rows.flatMap((row) =>
    row.status === 'pending' || row.status === 'authorized' ? [{ ...row, status: row.status }] : [],
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

/** Only an own property: a provider name from outside must never reach the prototype chain. */
function adapterOf(providers: ProviderMap, name: string): PaymentProvider | undefined {
  if (name !== 'mono' && name !== 'wayforpay') return undefined;
  return Object.hasOwn(providers, name) ? providers[name] : undefined;
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
  const alert = async (attempt: Candidate): Promise<void> => {
    if (await raiseAlert(deps.db, attempt)) result.alerts += 1;
  };
  const close = async (attempt: Candidate, reason: string, status?: 'expired'): Promise<void> => {
    const closed = await deps.db.transaction(
      async (tx) =>
        await recordAttemptRefused(tx, {
          attemptId: attempt.id,
          reason,
          ...(status === undefined ? {} : { status }),
        }),
    );
    if (closed) result.closed += 1;
  };

  async function reconcileOne(attempt: Candidate): Promise<void> {
    const adapter = adapterOf(deps.providers, attempt.provider);
    if (adapter === undefined) {
      // No adapter (a removed or rotated key): nothing can settle it, expiry skips the order. A
      // person must hear about it once the attempt has been open for a day.
      result.unaskable += 1;
      if (attempt.alertDue) await alert(attempt);
      return;
    }
    const key =
      adapter.statusLookupKey === 'localReference' ? attempt.localReference : attempt.externalId;
    if (key === null) {
      // Nothing to ask with (Mono, the create answer was lost).
      result.unaskable += 1;
      if (attempt.overdue) {
        await close(attempt, 'invoice never confirmed and its validity has passed', 'expired');
      } else if (attempt.alertDue) await alert(attempt);
      return;
    }
    result.checked += 1;
    try {
      const status = await adapter.getPaymentStatus(key);
      if (status.localReference !== null && status.localReference !== attempt.localReference) {
        result.providerErrors += 1;
        if (attempt.alertDue) await alert(attempt);
        return;
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
        // The provider answered about OUR invoice and the answer is consistent with the attempt:
        // it is no longer "unknown". A rejected answer proves nothing and changes nothing.
        const consistent =
          applied.kind === 'applied' ||
          (applied.kind === 'ignored' && applied.reason === 'no change');
        if (consistent) {
          await tx
            .update(paymentAttempts)
            .set({ state: 'in_flight' })
            .where(
              and(
                eq(paymentAttempts.id, attempt.id),
                inArray(paymentAttempts.state, ['pending', 'unknown']),
                inArray(paymentAttempts.status, ['pending', 'authorized']),
              ),
            );
        }
        return applied;
      });
      if (outcome.kind === 'applied') result.applied += 1;
      else if (outcome.kind === 'rejected') await alert(attempt);
      // A held payment that stays held for hours, or an open one for a day, needs a person.
      if (outcome.kind !== 'applied' && (attempt.authorizedOld || attempt.alertDue)) {
        await alert(attempt);
      }
    } catch (error) {
      if (error instanceof PaymentProviderError && error.status === 404) {
        // "No such payment" proves nothing about an invoice that exists (see the header): only an
        // attempt that never had a confirmed invoice, past its validity, is closed.
        if (attempt.externalId === null && attempt.overdue) {
          await close(attempt, 'the provider has no such payment and the invoice has expired');
          return;
        }
        result.providerErrors += 1;
        if (attempt.overdue) await alert(attempt);
        return;
      }
      result.providerErrors += 1;
      if (attempt.alertDue) await alert(attempt);
    }
  }

  let cursor: { at: string; id: string } | null = null;
  let seen = 0;
  while (seen < MAX_PER_RUN) {
    const page = await candidates(deps.db, cursor, deps.batch ?? PAGE_SIZE);
    const last = page.at(-1);
    if (last === undefined) break;
    for (const attempt of page) await reconcileOne(attempt);
    seen += page.length;
    cursor = { at: last.cursorAt, id: last.id };
  }
  return result;
}
