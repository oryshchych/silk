/**
 * One pricing path for the quote the buyer sees and the order that is stored:
 * discount first, then the delivery fee on the discounted goods, then the
 * final totals (docs/PROMO_CODES.md section 4).
 */
import { ZERO } from '@store/shared/money';

import { calculateCart, type CartPricing, type PromoRule } from '../pricing/calculate-cart.ts';
import type { DeliveryMethod, ShippingSettings } from '../shipping/rules.ts';
import { shippingFee } from '../shipping/rules.ts';
import type { CheckoutLine } from './checkout-lines.ts';

export interface PricedPromo {
  rule: PromoRule;
  eligibleVariantIds: ReadonlySet<string>;
}

export function priceCheckout(
  lines: readonly CheckoutLine[],
  promo: PricedPromo | null,
  method: DeliveryMethod,
  config: ShippingSettings,
): CartPricing {
  const inputs = lines.map((line) => ({
    id: line.variantId,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    eligible: promo?.eligibleVariantIds.has(line.variantId) ?? false,
  }));
  const goods = calculateCart(inputs, promo?.rule ?? null, ZERO);
  const fee = shippingFee(method, goods.subtotal, goods.discountTotal, config);
  return fee === ZERO ? goods : calculateCart(inputs, promo?.rule ?? null, fee);
}
