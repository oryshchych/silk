/**
 * Публічна картка товару (PLP, пошук). Собівартість, чернетки, службові
 * лічильники сюди не потрапляють за побудовою: їх немає в схемі.
 */
import { z } from 'zod';

import { fitSummaryDto, publicReviewDto } from './review';

import { moneyDto } from './money';

export const productBadgeValues = ['none', 'new', 'sale', 'bestseller', 'last_units'] as const;

export const imageDto = z.object({
  url: z.string(),
  alt: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export type ImageDto = z.output<typeof imageDto>;

export const productCardDto = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  brand: z.string(),
  price: moneyDto,
  compareAtPrice: moneyDto.nullable(),
  badge: z.enum(productBadgeValues),
  ratingAvg: z.number().min(1).max(5).nullable(),
  reviewsCount: z.number().int().nonnegative(),
  inStock: z.boolean(),
  /** Main image (first by sort order); null until media exists. */
  image: imageDto.nullable(),
});

export type ProductCardDto = z.output<typeof productCardDto>;

export const sizeSystemValues = ['bra', 'panty', 'apparel', 'onesize'] as const;

export const categoryDto = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  slug: z.string(),
  name: z.string(),
  depth: z.number().int().min(0).max(3),
  imageUrl: z.string().nullable(),
});

export type CategoryDto = z.output<typeof categoryDto>;

export const crumbDto = z.object({ slug: z.string(), name: z.string() });
export type CrumbDto = z.output<typeof crumbDto>;

export const categoryPageDto = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  seoText: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  noindex: z.boolean(),
  sizeSystem: z.enum(sizeSystemValues).nullable(),
  imageUrl: z.string().nullable(),
  breadcrumbs: z.array(crumbDto),
});

export type CategoryPageDto = z.output<typeof categoryPageDto>;

export const listingDto = z.object({
  items: z.array(productCardDto),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export type ListingDto = z.output<typeof listingDto>;

export const colorDto = z.object({ slug: z.string(), name: z.string(), hex: z.string() });
export type ColorDto = z.output<typeof colorDto>;

export const filterOptionsDto = z.object({
  bands: z.array(z.number().int()),
  cups: z.array(z.string()),
  sizes: z.array(z.object({ label: z.string(), system: z.enum(sizeSystemValues) })),
  colors: z.array(colorDto),
  brands: z.array(z.string()),
  price: z.object({ min: moneyDto, max: moneyDto }).nullable(),
});

export type FilterOptionsDto = z.output<typeof filterOptionsDto>;

/**
 * Variant as the buyer sees it. Stock counts never leave the server: only
 * whether the variant can be bought and whether few units are left.
 */
export const variantDto = z.object({
  id: z.uuid(),
  /** Public: it is the product feed `id` and the id analytics events carry. */
  sku: z.string(),
  sizeLabel: z.string(),
  sizeSystem: z.enum(sizeSystemValues),
  band: z.number().int().nullable(),
  cup: z.string().nullable(),
  colorSlug: z.string(),
  price: moneyDto,
  available: z.boolean(),
  lastUnits: z.boolean(),
});

export type VariantDto = z.output<typeof variantDto>;

export const productImageDto = imageDto.extend({ colorSlug: z.string().nullable() });
export type ProductImageDto = z.output<typeof productImageDto>;

export const productDetailDto = z.object({
  id: z.uuid(),
  slug: z.string(),
  sku: z.string(),
  brand: z.string(),
  name: z.string(),
  shortDescription: z.string().nullable(),
  description: z.string().nullable(),
  composition: z.string().nullable(),
  care: z.string().nullable(),
  price: moneyDto,
  compareAtPrice: moneyDto.nullable(),
  badge: z.enum(productBadgeValues),
  ratingAvg: z.number().min(1).max(5).nullable(),
  reviewsCount: z.number().int().nonnegative(),
  /** "68% say it fits", from approved reviews only; null without fit data. */
  fit: fitSummaryDto.nullable(),
  /** The newest APPROVED reviews: nothing pending or refused is ever read into a cached page. */
  reviews: z.array(publicReviewDto),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  ogImageUrl: z.string().nullable(),
  noindex: z.boolean(),
  category: crumbDto,
  breadcrumbs: z.array(crumbDto),
  images: z.array(productImageDto),
  colors: z.array(colorDto),
  variants: z.array(variantDto),
  attributes: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      values: z.array(z.object({ slug: z.string(), value: z.string() })),
    }),
  ),
});

export type ProductDetailDto = z.output<typeof productDetailDto>;
