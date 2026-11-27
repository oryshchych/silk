/**
 * Input of the promo-code admin. The allowlist of what an action can set (no mass assignment): money
 * arrives as text in hryvnias and becomes integer kopiykas (`parseHryvnias`, no float); times arrive as
 * Kyiv wall-clock text and are turned into instants by Postgres, never by the server's clock.
 */
import { z } from 'zod';

import { cleanText } from '@store/shared/content-text';
import { parseHryvnias } from '@store/shared/money';

const MAX_KOPIYKAS = 2_000_000_00;

const hryvnias = z
  .string()
  .trim()
  .max(16)
  .transform((value, ctx) => {
    try {
      const kopiykas = parseHryvnias(value);
      if (kopiykas < 0 || kopiykas > MAX_KOPIYKAS) throw new RangeError('out of range');
      return kopiykas;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not an amount in hryvnias' });
      return z.NEVER;
    }
  });

const optional = <T extends z.ZodType>(schema: T) =>
  z
    .union([z.literal(''), z.null(), schema])
    .transform((value) => (value === '' || value === null ? null : (value as z.output<T>)));

const wallClock = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/)
  .refine((value) => {
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
  }, 'not a real day');

export const PROMO_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
export const promoCodeField = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => PROMO_CODE_PATTERN.test(value), 'letters, digits, "-" and "_", 3 to 32');

const positiveInt = z.coerce.number().int().min(1).max(1_000_000);

/** The fields a form can set, shared by create and update. */
const editable = z.object({
  description: z
    .string()
    .refine((value) => !value.includes('\u0000'))
    .overwrite(cleanText)
    .trim()
    .max(300)
    .transform((value) => (value === '' ? null : value)),
  type: z.enum(['percent', 'fixed', 'free_shipping']),
  /** percent: whole number 1..100; fixed: hryvnias; free_shipping: ignored. */
  value: z.string().trim().max(16),
  maxDiscountAmount: optional(hryvnias),
  minOrderTotal: hryvnias,
  maxUses: optional(positiveInt),
  perCustomerLimit: optional(positiveInt),
  scope: z.enum(['all', 'category', 'product']),
  scopeCategoryId: optional(z.uuid()),
  scopeProductId: optional(z.uuid()),
  stackable: z.boolean(),
  excludesDiscountedItems: z.boolean(),
  firstOrderOnly: z.boolean(),
  excludesGiftCards: z.boolean(),
  startsAt: optional(wallClock),
  endsAt: optional(wallClock),
  isActive: z.boolean(),
});

type EditableInput = z.output<typeof editable>;
export interface PromoFields extends Omit<EditableInput, 'value'> {
  /** Kopiykas for `fixed`, a percentage for `percent`, 0 for free shipping. */
  value: number;
}

function normalise(input: EditableInput, ctx: z.RefinementCtx): PromoFields {
  const fail = (message: string): never => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  let value = 0;
  if (input.type === 'percent') {
    if (!/^\d{1,3}$/.test(input.value) || Number(input.value) < 1 || Number(input.value) > 100) {
      fail('a percentage is a whole number from 1 to 100');
    }
    value = Number(input.value);
  } else if (input.type === 'fixed') {
    const parsed = hryvnias.safeParse(input.value);
    if (!parsed.success || parsed.data <= 0) fail('a fixed discount is a positive amount');
    else value = parsed.data;
  }
  if (input.maxDiscountAmount !== null && input.type !== 'percent') {
    fail('a cap exists only for percentage codes');
  }
  const wantsCategory = input.scope === 'category';
  const wantsProduct = input.scope === 'product';
  if ((input.scopeCategoryId !== null) !== wantsCategory) fail('the category matches the scope');
  if ((input.scopeProductId !== null) !== wantsProduct) fail('the product matches the scope');
  if (input.startsAt !== null && input.endsAt !== null && input.startsAt >= input.endsAt) {
    fail('the end must be after the start');
  }
  return { ...input, value };
}

export const promoCreateSchema = editable
  .extend({ code: promoCodeField })
  .transform((input, ctx) => ({ ...normalise(input, ctx), code: input.code }));
export type PromoCreateInput = z.output<typeof promoCreateSchema>;

export const promoUpdateSchema = editable
  .extend({ id: z.uuid() })
  .transform((input, ctx) => ({ ...normalise(input, ctx), id: input.id }));
export type PromoUpdateInput = z.output<typeof promoUpdateSchema>;

export const promoBulkSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('deactivate'), ids: z.array(z.uuid()).min(1).max(100) }),
  z.object({
    op: z.literal('extend'),
    ids: z.array(z.uuid()).min(1).max(100),
    endsAt: wallClock,
  }),
]);
export type PromoBulkInput = z.output<typeof promoBulkSchema>;

export const promoIdSchema = z.object({ id: z.uuid() });
