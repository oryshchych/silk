'use server';

import { redirect } from 'next/navigation';

import { startCheckout } from '@store/core/cart';
import { getCartView } from '@store/core/cart-view';
import { DomainError, InsufficientStockError, PriceChangedError } from '@store/core/errors';
import { createOrder } from '@store/core/orders';
import { quoteCheckout } from '@store/core/quote';
import { formatMoney } from '@store/shared/money';

import { codeFor, RATE_LIMITED, type ActionFailure } from '@/lib/action-result';
import { mintCartToken, readCartToken, setCartCount, setOrderAccess } from '@/lib/cart-cookie';
import { placeOrderSchema, quoteSchema } from '@/lib/checkout-schemas';
import { getDb } from '@/lib/db';
import { errorReason } from '@/lib/error-reason';
import { href, paths } from '@/lib/paths';
import { checkLimit, limiters } from '@/lib/request-limits';

export interface QuoteSummary {
  subtotal: string;
  discount: string;
  shipping: string;
  total: string;
  /** `null` when no code was typed; the answer carries no reason on purpose. */
  promo: { code: string; accepted: boolean } | null;
  /** How much more is needed for free delivery, formatted, or null. */
  freeShippingRemaining: string | null;
}

export type QuoteResult = { ok: true; summary: QuoteSummary } | ActionFailure;

const log = (scope: string, fields: Record<string, string>): void => {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope, ...fields })}\n`);
};

/** Prices the cart for the chosen delivery and promo code and remembers the total the buyer sees. */
export async function quoteAction(input: unknown): Promise<QuoteResult> {
  const parsed = quoteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'CHECKOUT_DELIVERY_INVALID' };
  const verdict = await checkLimit(limiters.quote);
  if (!verdict.allowed) {
    return { ok: false, code: RATE_LIMITED, retryAfterSeconds: verdict.retryAfterSeconds };
  }
  const { locale, delivery, promoCode } = parsed.data;
  if (promoCode !== undefined && promoCode !== '') {
    const promoVerdict = await checkLimit(limiters.quotePromo);
    if (!promoVerdict.allowed) {
      return { ok: false, code: RATE_LIMITED, retryAfterSeconds: promoVerdict.retryAfterSeconds };
    }
  }
  const token = await readCartToken();
  if (token === null) return { ok: false, code: 'CHECKOUT_EMPTY_CART' };
  try {
    const db = await getDb();
    const intent = await db.transaction(
      async (tx) => await startCheckout(tx, { cartToken: token }),
    );
    const quote = await db.transaction(
      async (tx) =>
        await quoteCheckout(tx, {
          cartToken: token,
          intentId: intent.intentId,
          delivery,
          promoCode: promoCode === undefined || promoCode === '' ? null : promoCode,
          // The real reason is for the log only; the buyer gets one answer (PROMO_CODES.md 2).
          onPromoRejected: (reason) => {
            log('promo', { reason });
          },
        }),
    );
    const { pricing } = quote;
    return {
      ok: true,
      summary: {
        subtotal: formatMoney(pricing.subtotal, locale),
        discount: formatMoney(pricing.discountTotal, locale),
        shipping: formatMoney(pricing.shippingTotal, locale),
        total: formatMoney(pricing.total, locale),
        promo: quote.promo,
        freeShippingRemaining:
          quote.freeShippingRemaining === null
            ? null
            : formatMoney(quote.freeShippingRemaining, locale),
      },
    };
  } catch (error) {
    return { ok: false, code: codeFor(error) };
  }
}

interface StockProblemView {
  name: string;
  size: string;
  requested: number;
  available: number;
}

export type PlaceOrderResult =
  | { ok: false; kind: 'priceChanged'; newTotal: string }
  | { ok: false; kind: 'stock'; problems: StockProblemView[] }
  | { ok: false; kind: 'error'; code: string; retryAfterSeconds?: number };

/**
 * Places the order. Prices, the intent id and the owner come from the server; the browser sends
 * contact details, delivery, payment and a promo code. Redirects to the order page on success.
 */
export async function placeOrderAction(input: unknown): Promise<PlaceOrderResult> {
  const parsed = placeOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, kind: 'error', code: 'INVALID_FIELDS' };
  }
  const data = parsed.data;
  for (const [limiter, suffix] of [
    [limiters.place, ''],
    ...(data.payment === 'cod' ? ([[limiters.codPhone, data.phone]] as const) : []),
  ] as const) {
    const verdict = await checkLimit(limiter, suffix);
    if (!verdict.allowed) {
      return {
        ok: false,
        kind: 'error',
        code: RATE_LIMITED,
        retryAfterSeconds: verdict.retryAfterSeconds,
      };
    }
  }
  const token = await readCartToken();
  if (token === null) return { ok: false, kind: 'error', code: 'CHECKOUT_EMPTY_CART' };

  const db = await getDb();
  let created: { orderNumber: string; accessToken: string | null };
  try {
    const intent = await db.transaction(
      async (tx) => await startCheckout(tx, { cartToken: token }),
    );
    created = await db.transaction(
      async (tx) =>
        await createOrder(tx, {
          intentId: intent.intentId,
          ownerToken: token,
          contact: { email: data.email, phone: data.phone, name: data.name },
          delivery: {
            method: data.delivery,
            ...(data.settlementRef === undefined ? {} : { settlementRef: data.settlementRef }),
            ...(data.warehouseRef === undefined ? {} : { warehouseRef: data.warehouseRef }),
            ...(data.address === undefined ? {} : { address: data.address }),
          },
          paymentProvider: data.payment,
          promoCode: data.promoCode === undefined || data.promoCode === '' ? null : data.promoCode,
          locale: data.locale,
        }),
    );
  } catch (error) {
    if (error instanceof PriceChangedError) {
      return {
        ok: false,
        kind: 'priceChanged',
        newTotal: formatMoney(error.newTotal, data.locale),
      };
    }
    if (error instanceof InsufficientStockError) {
      const view = await getCartView(db, token, data.locale);
      const byVariant = new Map(view.lines.map((line) => [line.variantId, line]));
      return {
        ok: false,
        kind: 'stock',
        problems: error.problems.map((problem) => ({
          name: byVariant.get(problem.variantId)?.name ?? '',
          size: byVariant.get(problem.variantId)?.sizeLabel ?? '',
          requested: problem.requested,
          available: problem.available,
        })),
      };
    }
    if (!(error instanceof DomainError)) {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'checkout', reason: errorReason(error) })}\n`,
      );
    }
    return { ok: false, kind: 'error', code: codeFor(error) };
  }

  // Order exists. The cart was converted: rotate the token so the next purchase starts clean.
  if (created.accessToken !== null) await setOrderAccess(created.orderNumber, created.accessToken);
  await mintCartToken();
  await setCartCount(0);
  redirect(href(data.locale, paths.orderSuccess));
}
