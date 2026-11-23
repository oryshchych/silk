/**
 * Starts (or resumes) a card payment for an EXISTING order (ADR-11): the order is never created
 * again, and the reservation is never taken again.
 *
 *  1. transaction 1: the attempt row exists with its own `local_reference` (createPaymentAttempt);
 *  2. the provider is called WITHOUT a transaction held open;
 *  3. transaction 2: the answer is recorded (recordAttemptResult), or the refusal.
 *
 * A live invoice is reused, not replaced: while the previous attempt is still open the buyer is
 * sent to the SAME payment page. "Another card" after a failed attempt is a second attempt on the
 * same order. A lost answer is `unresolved`: reconciliation (getPaymentStatus, then the webhook)
 * decides, never a second invoice.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import { orders, paymentAttempts } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { PaymentProviderError } from '@store/payments/types';

import {
  AttemptStillOpenError,
  PaymentMethodUnavailableError,
  PaymentProviderRefusedError,
} from '../errors.ts';
import { loadShippingSettings } from '../shipping/rules.ts';
import {
  createPaymentAttempt,
  recordAttemptRefused,
  recordAttemptResult,
  type NewAttempt,
} from './attempts.ts';
import type { ProviderCode, ProviderMap } from './refunds.ts';

const VALIDITY_SECONDS = 30 * 60;

export interface StartPaymentDeps {
  /** Runs `fn` in a database transaction (core has no pool). */
  runInTransaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  providers: ProviderMap;
  /** Absolute URLs, built by the web layer from the runtime site URL. */
  urls: {
    returnUrl: (orderNumber: string) => string;
    webhookUrl: (provider: ProviderCode) => string;
  };
}

export type StartPaymentResult =
  /** Send the buyer here. `reused` is true when it is the invoice that already existed. */
  | { kind: 'redirect'; url: string; attemptId: string; reused: boolean }
  /** The provider's answer was lost: wait for the webhook or the reconciliation job. */
  | { kind: 'unresolved'; attemptId: string };

async function openInvoiceUrl(deps: StartPaymentDeps, orderId: string): Promise<string | null> {
  return await deps.runInTransaction(async (tx) => {
    const [row] = await tx
      .select({ url: paymentAttempts.redirectUrl })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.orderId, orderId),
          sql`${paymentAttempts.redirectUrl} IS NOT NULL`,
          sql`${paymentAttempts.state} IN ('pending', 'in_flight')`,
        ),
      )
      .orderBy(desc(paymentAttempts.attemptNumber))
      .limit(1);
    return row?.url ?? null;
  });
}

export async function startPayment(
  deps: StartPaymentDeps,
  input: { orderId: string; provider: ProviderCode },
): Promise<StartPaymentResult> {
  const adapter = deps.providers[input.provider];
  if (adapter === undefined) throw new PaymentMethodUnavailableError();

  let attempt: NewAttempt;
  try {
    attempt = await deps.runInTransaction(async (tx) => {
      const config = await loadShippingSettings(tx);
      if (!config.paymentProviders[input.provider]) throw new PaymentMethodUnavailableError();
      return await createPaymentAttempt(tx, input);
    });
  } catch (error) {
    if (error instanceof AttemptStillOpenError) {
      const url = await openInvoiceUrl(deps, input.orderId);
      if (url !== null) {
        const [open] = await deps.runInTransaction(
          async (tx) =>
            await tx
              .select({ id: orders.currentPaymentAttemptId })
              .from(orders)
              .where(eq(orders.id, input.orderId)),
        );
        return { kind: 'redirect', url, attemptId: open?.id ?? '', reused: true };
      }
    }
    throw error;
  }

  let result;
  try {
    result = await adapter.createPayment({
      localReference: attempt.localReference,
      amount: attempt.amount,
      currency: 'UAH',
      description: `Order ${attempt.orderNumber}`,
      redirectUrl: deps.urls.returnUrl(attempt.orderNumber),
      webhookUrl: deps.urls.webhookUrl(input.provider),
      validitySeconds: VALIDITY_SECONDS,
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      // A definite refusal: nothing was created, the order stays payable by another attempt.
      await deps.runInTransaction(async (tx) => {
        await recordAttemptRefused(tx, {
          attemptId: attempt.attemptId,
          reason: `provider refused (${String(error.status)})`,
        });
      });
      throw new PaymentProviderRefusedError();
    }
    // Anything else says nothing about whether the invoice exists: treat it as a lost answer.
    result = { ok: false, externalIdUnknown: true } as const;
  }

  await deps.runInTransaction(async (tx) => {
    await recordAttemptResult(tx, { attemptId: attempt.attemptId, result });
  });
  return result.ok
    ? { kind: 'redirect', url: result.redirectUrl, attemptId: attempt.attemptId, reused: false }
    : { kind: 'unresolved', attemptId: attempt.attemptId };
}
