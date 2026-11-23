/**
 * Delivery cost and checkout settings (docs/plan/phase-02-checkout.md).
 * Everything tunable lives in the `settings` table, with the defaults below
 * (owner queue Q26): the numbers are placeholders until the owner confirms the
 * real tariff. The calculation is pure and works in kopiykas.
 */
import { inArray } from 'drizzle-orm';

import { settings } from '@store/db/schema';
import type { Reader } from '@store/db/types';
import { money, subtract, ZERO, type Money } from '@store/shared/money';

export type DeliveryMethod = 'np_warehouse' | 'np_courier' | 'ukrposhta' | 'pickup';
export type PaymentProvider = 'mono' | 'wayforpay' | 'cod' | 'bank_transfer' | 'gift_card';

export interface ShippingSettings {
  /** Subtotal after discount at or above which delivery is free; null disables the rule. */
  freeShippingThreshold: Money | null;
  /** Flat fee per method in kopiykas. */
  rates: Record<DeliveryMethod, Money>;
  /** Payment methods the shop accepts at checkout. */
  paymentProviders: Record<PaymentProvider, boolean>;
  /** COD is refused above this total; null disables the cap. */
  codMaxAmount: Money | null;
  /** Unconfirmed COD orders one phone may hold at a time. */
  codMaxPendingPerPhone: number;
}

export const DEFAULT_SETTINGS: ShippingSettings = {
  freeShippingThreshold: money(200_000),
  rates: {
    np_warehouse: money(7_000),
    np_courier: money(12_000),
    ukrposhta: money(5_500),
    pickup: ZERO,
  },
  // Cards arrive with phase 3, so they are off until the provider is wired and switched on.
  paymentProviders: {
    mono: false,
    wayforpay: false,
    cod: true,
    bank_transfer: true,
    gift_card: false,
  },
  codMaxAmount: money(500_000),
  codMaxPendingPerPhone: 3,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const kopiykas = (value: unknown): Money | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? money(value) : undefined;

/** Reads the checkout settings; a missing or malformed key falls back to its default. */
export async function loadShippingSettings(reader: Reader): Promise<ShippingSettings> {
  const rows = await reader
    .select()
    .from(settings)
    .where(
      inArray(settings.key, [
        'free_shipping_threshold',
        'shipping_rates',
        'payment_providers',
        'cod_max_amount',
        'cod_limits',
      ]),
    );
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const result: ShippingSettings = {
    ...DEFAULT_SETTINGS,
    rates: { ...DEFAULT_SETTINGS.rates },
    paymentProviders: { ...DEFAULT_SETTINGS.paymentProviders },
  };

  const threshold = byKey.get('free_shipping_threshold');
  if (isRecord(threshold)) {
    if (threshold['amount'] === null) result.freeShippingThreshold = null;
    else
      result.freeShippingThreshold = kopiykas(threshold['amount']) ?? result.freeShippingThreshold;
  }
  const rates = byKey.get('shipping_rates');
  if (isRecord(rates)) {
    for (const method of Object.keys(result.rates) as DeliveryMethod[]) {
      result.rates[method] = kopiykas(rates[method]) ?? result.rates[method];
    }
  }
  const providers = byKey.get('payment_providers');
  if (isRecord(providers)) {
    for (const provider of Object.keys(result.paymentProviders) as PaymentProvider[]) {
      const flag = providers[provider];
      if (typeof flag === 'boolean') result.paymentProviders[provider] = flag;
    }
  }
  const codMax = byKey.get('cod_max_amount');
  if (isRecord(codMax)) {
    if (codMax['amount'] === null) result.codMaxAmount = null;
    else result.codMaxAmount = kopiykas(codMax['amount']) ?? result.codMaxAmount;
  }
  const limits = byKey.get('cod_limits');
  if (isRecord(limits)) {
    const pending = limits['max_pending_per_phone'];
    if (typeof pending === 'number' && Number.isInteger(pending) && pending > 0) {
      result.codMaxPendingPerPhone = pending;
    }
  }
  return result;
}

/**
 * Delivery fee for the goods value AFTER discounts. Pickup is always free;
 * the threshold is inclusive. (A `free_shipping` promo is applied later, by
 * `calculateCart`.)
 */
export function shippingFee(
  method: DeliveryMethod,
  subtotal: Money,
  discountTotal: Money,
  config: ShippingSettings,
): Money {
  if (method === 'pickup') return ZERO;
  const goods = subtract(subtotal, discountTotal);
  if (config.freeShippingThreshold !== null && goods >= config.freeShippingThreshold) return ZERO;
  return config.rates[method];
}
