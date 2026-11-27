import { PROMO_SORT_KEYS, type PromoFilters } from '@store/core/promo-admin';
import {
  promoScopeValues,
  promoStatusValues,
  promoTypeValues,
} from '@store/shared/dto/admin-promo';
import { z } from 'zod';

/**
 * The list filters as read from a query string: anything that is not a known value is dropped
 * (`.catch(undefined)`), so a hand-edited URL shows the unfiltered list instead of an error.
 */
const schema = z.object({
  q: z.string().max(100).optional().catch(undefined),
  status: z.enum(promoStatusValues).optional().catch(undefined),
  type: z.enum(promoTypeValues).optional().catch(undefined),
  scope: z.enum(promoScopeValues).optional().catch(undefined),
  createdFrom: z.string().max(10).optional().catch(undefined),
  createdTo: z.string().max(10).optional().catch(undefined),
  hasUses: z
    .literal('1')
    .transform(() => true)
    .optional()
    .catch(undefined),
  sort: z.enum(PROMO_SORT_KEYS).optional().catch(undefined),
  dir: z.enum(['asc', 'desc']).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
});

export function parsePromoFilters(
  raw: Record<string, string | string[] | undefined>,
): PromoFilters {
  const flat = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
  const parsed = schema.parse(flat);
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
}
