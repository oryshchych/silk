/**
 * Promo code resolution for checkout. The row is locked (level 6) together
 * with the variants before anything is validated, so two checkouts cannot both
 * take the last allowed use (docs/PROMO_CODES.md).
 */
import { eq, sql } from 'drizzle-orm';

import { promoCodes } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { money, type Money } from '@store/shared/money';

import { PromoRejectedError } from '../errors.ts';
import type { PromoRule } from '../pricing/calculate-cart.ts';
import type { CheckoutLine } from './checkout-lines.ts';

export interface ResolvedPromo {
  id: string;
  code: string;
  rule: PromoRule;
  minOrderTotal: Money;
  eligibleVariantIds: ReadonlySet<string>;
}

/** Unlocked lookup, only to learn which row to lock. */
export async function findPromoId(tx: Tx, code: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: promoCodes.id })
    .from(promoCodes)
    .where(sql`upper(${promoCodes.code}) = upper(${code})`);
  return row?.id ?? null;
}

/** Call with the promo row locked. Throws PromoRejectedError for any rule violation. */
export async function resolvePromo(
  tx: Tx,
  promoId: string,
  lines: readonly CheckoutLine[],
  subtotal: Money,
): Promise<ResolvedPromo> {
  const [promo] = await tx.select().from(promoCodes).where(eq(promoCodes.id, promoId));
  if (promo === undefined) throw new PromoRejectedError('unknown code');

  // Postgres owns time: the window is evaluated in SQL, not with Date.now().
  const windowRows = await tx.execute<{ open: boolean }>(
    sql`SELECT (starts_at IS NULL OR starts_at <= now())
            AND (ends_at IS NULL OR ends_at > now()) AS open
          FROM promo_codes WHERE id = ${promoId}`,
  );
  if (!promo.isActive || windowRows.rows[0]?.open !== true) {
    throw new PromoRejectedError('inactive or outside its dates');
  }
  if (promo.maxUses !== null && promo.usesCount >= promo.maxUses) {
    throw new PromoRejectedError('usage limit reached');
  }
  // Per-account limits need a confirmed account identity; checkout here is guest-only,
  // so such codes are refused instead of becoming unlimited (schema note on promo_code_redemptions).
  if (promo.perCustomerLimit !== null || promo.firstOrderOnly) {
    throw new PromoRejectedError('requires an account');
  }
  if (subtotal < promo.minOrderTotal) throw new PromoRejectedError('order total too low');

  const eligible = lines.filter(
    (line) =>
      (promo.scope === 'all' ||
        (promo.scope === 'product' && line.productId === promo.scopeProductId) ||
        (promo.scope === 'category' && line.categoryId === promo.scopeCategoryId)) &&
      !(promo.excludesDiscountedItems && line.hasCompareAtPrice),
  );
  if (eligible.length === 0 && promo.type !== 'free_shipping') {
    throw new PromoRejectedError('no eligible items');
  }

  return {
    id: promo.id,
    code: promo.code,
    rule: {
      type: promo.type,
      value: promo.value,
      maxDiscountAmount: promo.maxDiscountAmount === null ? null : money(promo.maxDiscountAmount),
    },
    minOrderTotal: money(promo.minOrderTotal),
    eligibleVariantIds: new Set(eligible.map((line) => line.variantId)),
  };
}
