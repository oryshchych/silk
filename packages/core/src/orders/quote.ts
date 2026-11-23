/**
 * Prices the cart for the checkout page and records the total the buyer is
 * about to confirm on the intent (Q12). Nothing here reserves stock or takes
 * a promo use; createOrder recomputes everything under its own locks and
 * refuses with PriceChangedError when the number moved.
 */
import { eq } from 'drizzle-orm';

import { carts, checkoutIntents } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { subtract, type Money } from '@store/shared/money';

import {
  CartConvertedError,
  EmptyCartError,
  IntentNotFoundError,
  InvalidCartTokenError,
  PromoRejectedError,
  StaleCartError,
  type PromoRejectReason,
} from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { calculateCart, type CartPricing } from '../pricing/calculate-cart.ts';
import { loadShippingSettings, type DeliveryMethod } from '../shipping/rules.ts';
import { loadCheckoutLines } from './checkout-lines.ts';
import { priceCheckout, type PricedPromo } from './price-checkout.ts';
import { findPromoId, resolvePromo } from './promo.ts';

const CART_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export interface CheckoutQuote {
  intentId: string;
  pricing: CartPricing;
  promo:
    | { code: string; accepted: true }
    | { code: string; accepted: false; reason: PromoRejectReason }
    | null;
  /** Free-delivery progress: how much more the goods need to reach the threshold (null: none). */
  freeShippingRemaining: Money | null;
}

export async function quoteCheckout(
  tx: Tx,
  input: {
    cartToken: string;
    intentId: string;
    delivery: DeliveryMethod;
    promoCode: string | null;
  },
): Promise<CheckoutQuote> {
  if (!CART_TOKEN.test(input.cartToken)) throw new InvalidCartTokenError();
  const [intent] = await tx
    .select()
    .from(checkoutIntents)
    .where(eq(checkoutIntents.id, input.intentId));
  if (intent?.ownerToken !== input.cartToken) throw new IntentNotFoundError();

  // Same order as createOrder: the cart first, then the intent.
  await acquireLocks(tx, { carts: [intent.cartId], checkout_intents: [intent.id] });
  const [cart] = await tx.select().from(carts).where(eq(carts.id, intent.cartId));
  if (cart === undefined || cart.convertedAt !== null) throw new CartConvertedError();
  if (cart.version !== intent.cartVersion) throw new StaleCartError();

  const lines = await loadCheckoutLines(tx, intent.cartId);
  if (lines.length === 0) throw new EmptyCartError();
  const config = await loadShippingSettings(tx);

  let promo: PricedPromo | null = null;
  let promoView: CheckoutQuote['promo'] = null;
  if (input.promoCode !== null) {
    const code = input.promoCode;
    try {
      const id = await findPromoId(tx, code);
      if (id === null) throw new PromoRejectedError('unknown code');
      const { subtotal } = calculateCart(
        lines.map((l) => ({
          id: l.variantId,
          unitPrice: l.unitPrice,
          quantity: l.quantity,
          eligible: false,
        })),
        null,
      );
      const resolved = await resolvePromo(tx, id, lines, subtotal);
      promo = resolved;
      promoView = { code: resolved.code, accepted: true };
    } catch (error) {
      if (!(error instanceof PromoRejectedError)) throw error;
      promoView = { code, accepted: false, reason: error.reason };
    }
  }

  const pricing = priceCheckout(lines, promo, input.delivery, config);
  if (intent.completedAt === null) {
    await tx
      .update(checkoutIntents)
      .set({ quotedTotal: pricing.total })
      .where(eq(checkoutIntents.id, intent.id));
  }
  const goods = subtract(pricing.subtotal, pricing.discountTotal);
  const threshold = config.freeShippingThreshold;
  return {
    intentId: intent.id,
    pricing,
    promo: promoView,
    freeShippingRemaining:
      threshold !== null && goods < threshold ? subtract(threshold, goods) : null,
  };
}
