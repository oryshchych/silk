/**
 * Input schemas of the catalog admin. They are the allowlist of what an action can change: a
 * field that is not here cannot be set through it (no mass assignment), and unknown keys are
 * dropped by zod. Prices come as text in hryvnias and become integer kopiykas through
 * `parseHryvnias` (no float, AGENTS.md section 2.1).
 */
import { z } from 'zod';

import { parseHryvnias } from '@store/shared/money';

/** Text without a NUL byte: Postgres refuses it (22021), so it is refused here with a clean error. */
const noNul = (value: string): boolean => !value.includes('\u0000');
const text = (max: number) => z.string().trim().max(max).refine(noNul, 'no NUL byte');
const optionalText = (max: number) =>
  text(max)
    .transform((value) => (value === '' ? null : value))
    .nullable();
export const slugField = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words joined by hyphens');
export const skuField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const hryvnias = z
  .string()
  .trim()
  .max(16)
  .transform((value, ctx) => {
    try {
      const kopiyky = parseHryvnias(value);
      if (kopiyky > 2_000_000_00) throw new RangeError('too large');
      return kopiyky;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not an amount in hryvnias' });
      return z.NEVER;
    }
  });
const positiveMoney = hryvnias.refine((value) => value > 0, 'must be positive');
const nonNegativeMoney = hryvnias.refine((value) => value >= 0, 'must not be negative');

const badge = z.enum(['none', 'new', 'sale', 'bestseller', 'last_units']);
const id = z.uuid();

/** Text, structure and SEO of a product: needs `catalog.edit`. Never a price. */
export const productContentSchema = z.object({
  productId: id,
  sku: skuField.optional(),
  slug: slugField.optional(),
  brand: text(120).min(1).optional(),
  categoryId: id.optional(),
  nameUk: text(300).min(1).optional(),
  nameEn: text(300).min(1).optional(),
  shortDescriptionUk: optionalText(500).optional(),
  shortDescriptionEn: optionalText(500).optional(),
  descriptionUk: optionalText(20_000).optional(),
  descriptionEn: optionalText(20_000).optional(),
  compositionUk: optionalText(5_000).optional(),
  compositionEn: optionalText(5_000).optional(),
  careUk: optionalText(5_000).optional(),
  careEn: optionalText(5_000).optional(),
  weightGrams: z.number().int().min(1).max(50_000).optional(),
  uktzedCode: optionalText(20).optional(),
  isFeatured: z.boolean().optional(),
  badge: badge.optional(),
  metaTitleUk: optionalText(200).optional(),
  metaTitleEn: optionalText(200).optional(),
  metaDescriptionUk: optionalText(400).optional(),
  metaDescriptionEn: optionalText(400).optional(),
  noindex: z.boolean().optional(),
});
export type ProductContentInput = z.output<typeof productContentSchema>;

/** Prices of a product: needs `catalog.price`. */
export const productPricingSchema = z.object({
  productId: id,
  basePrice: positiveMoney.optional(),
  compareAtPrice: positiveMoney.nullable().optional(),
  costPrice: nonNegativeMoney.nullable().optional(),
});
export type ProductPricingInput = z.output<typeof productPricingSchema>;

/** A new product starts as a draft. Needs `catalog.create`. */
export const createProductSchema = z.object({
  sku: skuField,
  slug: slugField,
  brand: text(120).min(1),
  categoryId: id,
  nameUk: text(300).min(1),
  nameEn: text(300).min(1),
  basePrice: positiveMoney,
  costPrice: nonNegativeMoney.nullable().optional(),
  weightGrams: z.number().int().min(1).max(50_000).default(200),
});
export type CreateProductInput = z.output<typeof createProductSchema>;

export const setActiveSchema = z.object({ productId: id, isActive: z.boolean() });

export const generateVariantsSchema = z.object({
  productId: id,
  sizeIds: z.array(id).min(1).max(40),
  colorIds: z.array(id).min(1).max(40),
});

/** Non-price fields of a variant: needs `catalog.edit`. */
export const variantContentSchema = z.object({
  variantId: id,
  sku: skuField.optional(),
  barcode: optionalText(64).optional(),
  isActive: z.boolean().optional(),
  weightGrams: z.number().int().min(1).max(50_000).nullable().optional(),
});

/** The price override of a variant: needs `catalog.price`. */
export const variantPricingSchema = z.object({
  variantId: id,
  priceOverride: positiveMoney.nullable(),
});

export const createCategorySchema = z.object({
  parentId: id.nullable(),
  slug: slugField,
  nameUk: text(200).min(1),
  nameEn: text(200).min(1),
  sizeSystem: z.enum(['bra', 'panty', 'apparel', 'onesize']).nullable().optional(),
});

export const updateCategorySchema = z.object({
  categoryId: id,
  slug: slugField.optional(),
  nameUk: text(200).min(1).optional(),
  nameEn: text(200).min(1).optional(),
  descriptionUk: optionalText(5_000).optional(),
  descriptionEn: optionalText(5_000).optional(),
  seoTextUk: optionalText(20_000).optional(),
  seoTextEn: optionalText(20_000).optional(),
  sizeSystem: z.enum(['bra', 'panty', 'apparel', 'onesize']).nullable().optional(),
  isActive: z.boolean().optional(),
  noindex: z.boolean().optional(),
  metaTitleUk: optionalText(200).optional(),
  metaTitleEn: optionalText(200).optional(),
  metaDescriptionUk: optionalText(400).optional(),
  metaDescriptionEn: optionalText(400).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});

export const moveCategorySchema = z.object({
  categoryId: id,
  parentId: id.nullable(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});

export const colorSchema = z.object({
  colorId: id.optional(),
  slug: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  nameUk: text(80).min(1),
  nameEn: text(80).min(1),
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});

export const sizeSchema = z.object({
  sizeId: id.optional(),
  system: z.enum(['bra', 'panty', 'apparel', 'onesize']),
  label: text(20).min(1),
  band: z.number().int().min(60).max(110).nullable().default(null),
  cup: text(4).min(1).nullable().default(null),
  euLabel: optionalText(20).default(null),
  usLabel: optionalText(20).default(null),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});

export const attributeSchema = z.object({
  attributeId: id.optional(),
  code: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  nameUk: text(120).min(1),
  nameEn: text(120).min(1),
  type: z.enum(['select', 'multiselect', 'boolean', 'text']),
  isFilterable: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});

export const attributeValueSchema = z.object({
  attributeId: id,
  valueId: id.optional(),
  slug: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  valueUk: text(160).min(1),
  valueEn: text(160).min(1),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});

export const setProductAttributesSchema = z.object({
  productId: id,
  attributeValueIds: z.array(id).max(100),
});
