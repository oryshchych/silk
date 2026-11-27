/**
 * Admin promo-code DTOs: an explicit list of fields, so a column added to `promo_codes` later does not
 * reach the browser by accident. Money is integer kopiykas. The author of a code is a staff e-mail and
 * exists only in the shape for a role that may manage codes (`promo.manage`); a manager reads the codes
 * without it.
 */
import { z } from 'zod';

import { moneyDto } from './money';

export const promoTypeValues = ['percent', 'fixed', 'free_shipping'] as const;
export const promoScopeValues = ['all', 'category', 'product'] as const;
/** `inactive` first: a switched-off code is "off" whatever its dates say. */
export const promoStatusValues = ['active', 'inactive', 'exhausted', 'ended', 'upcoming'] as const;

const instant = z.iso.datetime({ offset: true });

export const adminPromoRowDto = z.object({
  id: z.uuid(),
  code: z.string(),
  description: z.string().nullable(),
  type: z.enum(promoTypeValues),
  /** percent: 1..100; fixed: kopiykas; free_shipping: 0. */
  value: z.number().int(),
  maxDiscountAmount: moneyDto.nullable(),
  minOrderTotal: moneyDto,
  maxUses: z.number().int().nullable(),
  /** The stored counter; the statistics below are counted from the redemptions, never from it. */
  usesCount: z.number().int(),
  perCustomerLimit: z.number().int().nullable(),
  scope: z.enum(promoScopeValues),
  scopeCategoryId: z.uuid().nullable(),
  scopeProductId: z.uuid().nullable(),
  stackable: z.boolean(),
  excludesDiscountedItems: z.boolean(),
  firstOrderOnly: z.boolean(),
  excludesGiftCards: z.boolean(),
  startsAt: instant.nullable(),
  endsAt: instant.nullable(),
  isActive: z.boolean(),
  status: z.enum(promoStatusValues),
  createdAt: instant,
  /** Redemptions in state `consumed`: the real number of uses. */
  consumedCount: z.number().int(),
  /** Sum of `discount_amount` over the consumed redemptions, unpaid orders included. */
  discountTotal: moneyDto,
  /** Sum of `captured_total - refunded_total` of the orders behind the consumed redemptions: money really kept. */
  netTotal: moneyDto,
  /** Any redemption row, consumed or released: the type, value and scope are then frozen. */
  hasRedemptions: z.boolean(),
});
export type AdminPromoRowDto = z.output<typeof adminPromoRowDto>;

export const adminPromoRowWithAuthorDto = adminPromoRowDto.extend({
  createdBy: z.string().nullable(),
});
export type AdminPromoRowWithAuthorDto = z.output<typeof adminPromoRowWithAuthorDto>;

/** What one code did, for its statistics block. */
export const adminPromoStatsDto = z.object({
  consumedCount: z.number().int(),
  releasedCount: z.number().int(),
  discountTotal: moneyDto,
  netTotal: moneyDto,
  /** Average captured amount of an order with the code, null when there is none. */
  averageOrderWithCode: moneyDto.nullable(),
  /** Average captured amount of the other paid orders, null when there is none. */
  averageOrderWithout: moneyDto.nullable(),
  newCustomers: z.number().int(),
  byDay: z.array(z.object({ day: z.string(), uses: z.number().int() })),
  orders: z.array(
    z.object({
      id: z.uuid(),
      orderNumber: z.string(),
      createdAt: instant,
      discountAmount: moneyDto,
      netTotal: moneyDto,
    }),
  ),
});
export type AdminPromoStatsDto = z.output<typeof adminPromoStatsDto>;
