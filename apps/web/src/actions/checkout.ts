'use server';

import { currentConsentRefs } from '@store/core/legal-read';
import { redirect } from 'next/navigation';

import { startCheckout } from '@store/core/cart';
import { getCartView } from '@store/core/cart-view';
import { DomainError, InsufficientStockError, PriceChangedError } from '@store/core/errors';
import { createOrder } from '@store/core/orders';
import { quoteCheckout } from '@store/core/quote';
import { formatMoney } from '@store/shared/money';

import { codeFor, RATE_LIMITED, type ActionFailure } from '@/lib/action-result';
import {
  mintCartToken,
  readCartToken,
  readOrderAccess,
  setCartCount,
  setOrderAccess,
} from '@/lib/cart-cookie';
import { placeOrderSchema, quoteSchema } from '@/lib/checkout-schemas';
import { getDb } from '@/lib/db';
import { errorReason } from '@/lib/error-reason';
import { beginCardPayment } from '@/lib/pay';
import { href, paths } from '@/lib/paths';
import { checkLimit, limiters } from '@/lib/request-limits';

type Delivery = 'np_warehouse' | 'np_courier' | 'ukrposhta' | 'pickup';

export interface QuoteSummary {
  /** False when no discount applies: the page hides the discount row. */
  hasDiscount: boolean;
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
        hasDiscount: pricing.discountTotal > 0,
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
    const missingTerms = parsed.error.issues.some((issue) => issue.path[0] === 'terms');
    return {
      ok: false,
      kind: 'error',
      code: missingTerms ? 'CHECKOUT_TERMS_REQUIRED' : 'INVALID_FIELDS',
    };
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
  let created: { orderId: string; orderNumber: string; accessToken: string | null };
  try {
    const intent = await db.transaction(
      async (tx) => await startCheckout(tx, { cartToken: token }),
    );
    created = await db.transaction(
      async (tx) =>
        await createOrder(tx, {
          // Resolved INSIDE the order's transaction (database clock): the edition stored is the one in force at the commit.
          consentRefs: await currentConsentRefs(tx, data.locale),
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
          termsAccepted: data.terms,
        }),
    );
  } catch (error) {
    if (error instanceof PriceChangedError) {
      // The buyer confirms the new total by pressing the button again, so the server must hold
      // THAT total now: quote again (own transactions) before answering. Without it every
      // further press would fail on the old figure.
      await requote(db, token, data).catch((reason: unknown) => {
        log('requote', { reason: errorReason(reason) });
      });
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
  // A card order goes straight to the provider's page: a new ATTEMPT on the order that exists
  // (ADR-11). If the provider is down or the answer is lost the order page takes over (it shows
  // the real status and offers to pay again); the order itself is never lost.
  if (data.payment === 'mono' || data.payment === 'wayforpay') {
    const url = await cardPaymentUrl(created.orderId, data.payment, data.locale);
    if (url !== null) redirect(url);
  }
  // A replay (the first answer was lost, or a second tab submitted) gets no new token: the order
  // page needs this browser's cookie, so without it the buyer is sent to tracking with a notice.
  const access = await readOrderAccess();
  const ownsOrder = access?.orderNumber === created.orderNumber;
  redirect(
    created.accessToken !== null || ownsOrder
      ? href(data.locale, paths.orderSuccess)
      : href(data.locale, paths.orderTrack, 'placed=1'),
  );
}

async function cardPaymentUrl(
  orderId: string,
  provider: 'mono' | 'wayforpay',
  locale: 'uk' | 'en',
): Promise<string | null> {
  try {
    const started = await beginCardPayment(orderId, provider, locale);
    return started.kind === 'redirect' ? started.url : null;
  } catch (error) {
    log('pay', { reason: errorReason(error) });
    return null;
  }
}

/** Prices the cart again for the buyer's current choices, so the intent holds the figure they see. */
async function requote(
  db: Awaited<ReturnType<typeof getDb>>,
  token: string,
  data: { delivery: Delivery; promoCode?: string | undefined },
): Promise<void> {
  const intent = await db.transaction(async (tx) => await startCheckout(tx, { cartToken: token }));
  await db.transaction(async (tx) => {
    await quoteCheckout(tx, {
      cartToken: token,
      intentId: intent.intentId,
      delivery: data.delivery,
      promoCode: data.promoCode === undefined || data.promoCode === '' ? null : data.promoCode,
    });
  });
}
