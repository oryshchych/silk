import { z } from 'zod';

import { normalizeUaPhone } from '@store/shared/phone';

import { oneOf } from './pay-schema';

const UUID = z.uuid();
/** A NUL byte cannot be stored in a Postgres text column: refuse it at the edge. */
const text = (schema: z.ZodString) => schema.refine((value) => !value.includes('\0'));
/** Names and addresses are copied into emails (to the shop and to the typed address): no links. */
const plainText = (schema: z.ZodString) =>
  text(schema).refine((value) => !/https?:|www\./i.test(value));
const locale = oneOf(['uk', 'en']);

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
  name: plainText(z.string().trim().min(2).max(100)),
  email: z.email().max(254),
  phone,
  delivery: oneOf(['np_warehouse', 'np_courier', 'ukrposhta', 'pickup']),
  settlementRef: text(z.string().max(64)).optional(),
  warehouseRef: text(z.string().max(64)).optional(),
  address: plainText(z.string().trim().max(300)).optional(),
  payment: oneOf(['cod', 'bank_transfer', 'mono', 'wayforpay']),
  promoCode: text(z.string().trim().max(64)).optional(),
  /** The buyer accepted the terms and the privacy policy: refused when absent or false. */
  terms: z.literal(true),
});

export const quoteSchema = z.object({
  locale,
  delivery: oneOf(['np_warehouse', 'np_courier', 'ukrposhta', 'pickup']),
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
