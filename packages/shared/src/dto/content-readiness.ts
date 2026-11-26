/**
 * The content readiness report (phase 9). An explicit list of fields for every shape: nothing of
 * the product row beyond what the report needs leaves the server, and there is NO cost field in
 * any shape, so the report is the same for every role that may open it (no `...WithCost` pair).
 * Staff-entered text (names, slugs) is data: the screen escapes it, and the CLI prints it as JSON.
 */
import { z } from 'zod';

export const contentLocaleValues = ['uk', 'en'] as const;
export const contentFieldValues = [
  'name',
  'short_description',
  'description',
  'composition',
  'care',
  'meta_title',
  'meta_description',
  'alt',
  'seo_text',
] as const;
export const findingCodeValues = [
  // state
  'inactive',
  'unpublished',
  'category_hidden',
  'slug_unservable',
  'noindex',
  'brand_missing',
  'price_missing',
  'no_active_variant',
  'no_stock',
  'no_attributes',
  'gtin_missing',
  'variant_sku_too_long',
  'no_products',
  // text
  'missing',
  'too_short',
  'too_long',
  'same_in_both_languages',
  'duplicate_in_catalog',
  'claim_review',
  // photos
  'no_photo',
  'photo_alt_missing',
  'photo_alt_too_short',
  'photo_alt_too_long',
  'photo_too_narrow',
  'photo_aspect',
  'photo_renditions_missing',
  'photo_url_unsafe',
] as const;
export type FindingCode = (typeof findingCodeValues)[number];
export type ContentFieldName = (typeof contentFieldValues)[number];

export const findingDto = z.object({
  code: z.enum(findingCodeValues),
  /** A `blocker` fails the launch gate for a product that is meant to be live; a `warning` never does. */
  severity: z.enum(['blocker', 'warning']),
  field: z.enum(contentFieldValues).nullable(),
  locale: z.enum(contentLocaleValues).nullable(),
  /** For photo findings: how many of the product's photos have the problem. */
  count: z.number().int().nullable(),
});
export type FindingDto = z.output<typeof findingDto>;

export const productReadinessDto = z.object({
  id: z.uuid(),
  sku: z.string(),
  slug: z.string(),
  nameUk: z.string().max(300),
  nameEn: z.string().max(300),
  /** `is_active`: the owner meant it to be sold (a draft has this false). */
  isActive: z.boolean(),
  /** The storefront would show it right now (the same rule as the catalogue: active, published, visible category). */
  live: z.boolean(),
  /** No blocker. */
  ready: z.boolean(),
  photoCount: z.number().int(),
  activeVariantCount: z.number().int(),
  findings: z.array(findingDto),
});
export type ProductReadinessDto = z.output<typeof productReadinessDto>;

export const categoryReadinessDto = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameUk: z.string().max(300),
  nameEn: z.string().max(300),
  isActive: z.boolean(),
  noindex: z.boolean(),
  liveProductCount: z.number().int(),
  seoTextLengthUk: z.number().int(),
  seoTextLengthEn: z.number().int(),
  ready: z.boolean(),
  findings: z.array(findingDto),
});
export type CategoryReadinessDto = z.output<typeof categoryReadinessDto>;

export const photoIssueValues = [
  'alt_missing_uk',
  'alt_missing_en',
  'alt_too_short',
  'alt_too_long',
  'too_narrow',
  'aspect',
  'renditions_missing',
  'url_unsafe',
] as const;

export const photoProblemDto = z.object({
  imageId: z.uuid(),
  productId: z.uuid(),
  productSku: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  issues: z.array(z.enum(photoIssueValues)),
});
export type PhotoProblemDto = z.output<typeof photoProblemDto>;

export const acceptanceCheckDto = z.object({
  id: z.enum([
    'active_products',
    'variants_stock_photos',
    'alt_meta_photo',
    'category_seo_text',
    'no_blockers',
  ]),
  ok: z.boolean(),
  actual: z.number().int(),
  expected: z.number().int(),
});

export type AcceptanceCheck = z.output<typeof acceptanceCheckDto>;

export const contentReadinessDto = z.object({
  generatedAt: z.iso.datetime(),
  expectedActive: z.number().int(),
  totals: z.object({
    products: z.number().int(),
    /** Shown by the storefront now. */
    live: z.number().int(),
    liveReady: z.number().int(),
    /** `is_active`, whether or not the storefront shows it yet. */
    active: z.number().int(),
    activeReady: z.number().int(),
    drafts: z.number().int(),
    draftsReady: z.number().int(),
    categories: z.number().int(),
    categoriesReady: z.number().int(),
    photos: z.number().int(),
    photosWithProblems: z.number().int(),
  }),
  acceptance: z.array(acceptanceCheckDto),
  /** The launch gate: every acceptance check passes (the last one is "no blocker anywhere"). */
  gatePassed: z.boolean(),
  /** Not ready first (by SKU), then the rest. Capped: see `productsTruncated`. */
  products: z.array(productReadinessDto),
  productsTruncated: z.boolean(),
  categories: z.array(categoryReadinessDto),
  photoProblems: z.array(photoProblemDto),
  photoProblemsTruncated: z.boolean(),
});
export type ContentReadinessDto = z.output<typeof contentReadinessDto>;
