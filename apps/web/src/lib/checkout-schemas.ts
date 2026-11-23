import { z } from 'zod';

import { normalizeUaPhone } from '@store/shared/phone';

const UUID = z.uuid();
/** A NUL byte cannot be stored in a Postgres text column: refuse it at the edge. */
const text = (schema: z.ZodString) => schema.refine((value) => !value.includes('\0'));
const locale = z.enum(['uk', 'en']);

/** Phone typed in any common way, stored in the canonical `+380XXXXXXXXX` form. */
const phone = z
  .string()
  .max(32)
  .transform((raw, ctx) => {
    const normalized = normalizeUaPhone(raw);
    if (normalized === null) {
      ctx.addIssue({ code: 'custom', message: 'phone' });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * What the buyer may send for an order. Prices, totals and the intent id are NOT here:
 * the server derives them (AGENTS.md 2.2), and unknown keys (a `total`, `allowUnquoted`)
 * are dropped by the parse.
 */
export const placeOrderSchema = z.object({
  locale,
  name: text(z.string().trim().min(2).max(100)),
  email: z.email().max(254),
  phone,
  delivery: z.enum(['np_warehouse', 'np_courier', 'ukrposhta', 'pickup']),
  settlementRef: text(z.string().max(64)).optional(),
  warehouseRef: text(z.string().max(64)).optional(),
  address: text(z.string().trim().max(300)).optional(),
  payment: z.enum(['cod', 'bank_transfer', 'mono', 'wayforpay']),
  promoCode: text(z.string().trim().max(64)).optional(),
});

export const quoteSchema = z.object({
  locale,
  delivery: z.enum(['np_warehouse', 'np_courier', 'ukrposhta', 'pickup']),
  promoCode: text(z.string().trim().max(64)).optional(),
});

export const cartLineSchema = z.object({
  variantId: UUID,
  quantity: z.number().int().min(0).max(99),
});

export const addToCartSchema = z.object({
  variantId: UUID,
  quantity: z.number().int().min(1).max(99).default(1),
});

export const trackSchema = z.object({
  orderNumber: text(z.string().trim().max(32)),
  phone,
});
