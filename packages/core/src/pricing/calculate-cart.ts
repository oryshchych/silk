/**
 * Cart pricing (docs/PROMO_CODES.md section 4). The single place where a
 * percentage becomes kopiykas: floor, decided here, before anything is written
 * (ADR-1). Pure: prices come from the database, the caller passes them in.
 *
 * `subtotal` does NOT include the line discount, so
 * `subtotal = SUM(line_total + line_discount)`; the discount is subtracted
 * exactly once, in `total`.
 */
import {
  add,
  assertFitsPgInteger,
  money,
  multiply,
  percentOf,
  subtract,
  sum,
  ZERO,
  type Money,
} from '@store/shared/money';

import { allocateLineDiscounts } from './allocate-discount.ts';

export interface CartLineInput {
  id: string;
  unitPrice: Money;
  quantity: number;
  /** The promo applies to this line (scope, excluded items already resolved). */
  eligible: boolean;
}

export interface PromoRule {
  type: 'percent' | 'fixed' | 'free_shipping';
  /** percent: 1..100; fixed: kopiykas; free_shipping: 0. */
  value: number;
  maxDiscountAmount: Money | null;
}

export interface PricedLine {
  id: string;
  unitPrice: Money;
  quantity: number;
  lineSubtotal: Money;
  lineDiscount: Money;
  lineTotal: Money;
}

export interface CartPricing {
  lines: PricedLine[];
  subtotal: Money;
  discountTotal: Money;
  shippingTotal: Money;
  total: Money;
}

export function calculateDiscount(rule: PromoRule, eligibleSubtotal: Money): Money {
  assertValidRule(rule);
  // docs/PROMO_CODES.md section 4: raw discount per type, then one cap applied to any type.
  let raw: Money;
  switch (rule.type) {
    case 'percent':
      raw = percentOf(eligibleSubtotal, rule.value, 'floor');
      break;
    case 'fixed':
      raw = money(rule.value) < eligibleSubtotal ? money(rule.value) : eligibleSubtotal;
      break;
    case 'free_shipping':
      return ZERO;
  }
  return rule.maxDiscountAmount !== null && rule.maxDiscountAmount < raw
    ? rule.maxDiscountAmount
    : raw;
}

function assertValidRule(rule: PromoRule): void {
  if (rule.maxDiscountAmount !== null && rule.maxDiscountAmount < 0) {
    throw new RangeError('max discount amount must not be negative');
  }
  if (rule.type === 'fixed' && rule.value < 0) {
    throw new RangeError('fixed discount must not be negative');
  }
  if (rule.type === 'percent' && (rule.value < 1 || rule.value > 100)) {
    throw new RangeError('percent discount must be 1..100');
  }
}

/** quantity comes from the client (AGENTS.md 2.2): the boundary is checked here. */
const MAX_QUANTITY = 99;

function assertValidInput(inputs: readonly CartLineInput[], shippingTotal: Money): void {
  for (const line of inputs) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) {
      throw new RangeError(`quantity must be an integer 1..${String(MAX_QUANTITY)}`);
    }
    if (line.unitPrice < 0) throw new RangeError('unit price must not be negative');
  }
  if (shippingTotal < 0) throw new RangeError('shipping must not be negative');
}

export function calculateCart(
  inputs: readonly CartLineInput[],
  promo: PromoRule | null,
  carrierShipping: Money = ZERO,
): CartPricing {
  assertValidInput(inputs, carrierShipping);
  // docs/PROMO_CODES.md section 4, step 6. Manual adjustments are out of scope here.
  const shippingTotal = promo?.type === 'free_shipping' ? ZERO : carrierShipping;
  const base = inputs.map((line) => ({
    ...line,
    lineSubtotal: multiply(line.unitPrice, line.quantity),
  }));
  const subtotal = sum(base.map((line) => line.lineSubtotal));
  const eligibleSubtotal = sum(base.filter((line) => line.eligible).map((l) => l.lineSubtotal));

  const discountTotal = promo === null ? ZERO : calculateDiscount(promo, eligibleSubtotal);
  const discounts = allocateLineDiscounts(base, discountTotal);

  const lines = base.map((line, index): PricedLine => {
    // `?? ZERO` only satisfies noUncheckedIndexedAccess: one discount per input line.
    /* v8 ignore next */
    const lineDiscount = discounts[index] ?? ZERO;
    return {
      id: line.id,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      lineSubtotal: line.lineSubtotal,
      lineDiscount,
      lineTotal: subtract(line.lineSubtotal, lineDiscount),
    };
  });

  // ADR-1 step 4: every value must fit a Postgres integer column before it is written.
  const total = add(subtract(subtotal, discountTotal), shippingTotal);
  [subtotal, total, ...lines.map((l) => l.lineSubtotal)].forEach(assertFitsPgInteger);

  return { lines, subtotal, discountTotal, shippingTotal, total };
}
