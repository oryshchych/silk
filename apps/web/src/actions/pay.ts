'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { DomainError } from '@store/core/errors';
import { resolveOrderForPayment } from '@store/core/order-lookup';

import { codeFor, RATE_LIMITED, type ActionFailure } from '@/lib/action-result';
import { readOrderAccess } from '@/lib/cart-cookie';
import { getDb } from '@/lib/db';
import { errorReason } from '@/lib/error-reason';
import { beginCardPayment } from '@/lib/pay';
import { checkLimit, limiters } from '@/lib/request-limits';

const schema = z.object({
  locale: z.enum(['uk', 'en']),
  provider: z.enum(['mono', 'wayforpay']),
});

const CARD_PROVIDERS: ReadonlySet<string | null> = new Set(['mono', 'wayforpay']);
const PAYABLE: ReadonlySet<string> = new Set(['pending', 'failed', 'expired']);

/**
 * "Pay" and "pay with another card or provider" on the order page. It works on the order this
 * browser placed (access cookie) and NEVER creates an order: a failed attempt is followed by a
 * new ATTEMPT on the same order, and a live invoice is reused (ADR-11). On success it redirects
 * to the provider's payment page. The paid state is not set here, only by a verified webhook or
 * the reconciliation job.
 */
export async function payOrderAction(input: unknown): Promise<ActionFailure> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_FIELDS' };
  const verdict = await checkLimit(limiters.pay);
  if (!verdict.allowed) {
    return { ok: false, code: RATE_LIMITED, retryAfterSeconds: verdict.retryAfterSeconds };
  }
  const access = await readOrderAccess();
  if (access === null) return { ok: false, code: 'TRACK_NOT_FOUND' };
  const db = await getDb();
  const order = await resolveOrderForPayment(db, access.orderNumber, access.token);
  if (order === null) return { ok: false, code: 'TRACK_NOT_FOUND' };
  // Only a card order that is still unpaid and alive can start a payment.
  if (
    !CARD_PROVIDERS.has(order.paymentProvider) ||
    !PAYABLE.has(order.paymentStatus) ||
    order.status !== 'pending'
  ) {
    return { ok: false, code: 'PAYMENT_ORDER_NOT_PAYABLE' };
  }
  let url: string | null = null;
  try {
    const started = await beginCardPayment(order.id, parsed.data.provider, parsed.data.locale);
    if (started.kind === 'redirect') url = started.url;
    else return { ok: false, code: 'PAYMENT_ATTEMPT_UNRESOLVED' };
  } catch (error) {
    if (!(error instanceof DomainError)) {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'pay', reason: errorReason(error) })}\n`,
      );
    }
    return { ok: false, code: codeFor(error) };
  }
  // Outside the try: `redirect` works by throwing.
  redirect(url);
}
