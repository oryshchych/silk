/**
 * Admin catalog DTOs. An explicit list of fields, and TWO shapes where a field is role-dependent:
 * `costPrice` exists only in the `...WithCost` schemas, so a role that may not see it is serialised
 * through a schema in which the key does not exist (zod drops unknown keys: the value cannot slip
 * through even if the row carries it). The caller picks the schema from the role's permission
 * (`catalog.cost.view`); `serializeAdminProduct` below is that choice in one place.
 */
import { z } from 'zod';

import { moneyDto } from './money';
import { productBadgeValues, sizeSystemValues } from './catalog';

export const adminVariantDto = z.object({
  id: z.uuid(),
  sku: z.string(),
  barcode: z.string().nullable(),
  sizeId: z.uuid(),
  sizeLabel: z.string(),
  colorId: z.uuid(),
  colorName: z.string(),
  priceOverride: moneyDto.nullable(),
  stockQuantity: z.number().int(),
  reservedQuantity: z.number().int(),
  isActive: z.boolean(),
});

const adminProductFields = {
  id: z.uuid(),
  sku: z.string(),
  slug: z.string(),
  brand: z.string(),
  categoryId: z.uuid(),
  nameUk: z.string(),
  nameEn: z.string(),
  shortDescriptionUk: z.string().nullable(),
  shortDescriptionEn: z.string().nullable(),
  descriptionUk: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  compositionUk: z.string().nullable(),
  compositionEn: z.string().nullable(),
  careUk: z.string().nullable(),
  careEn: z.string().nullable(),
  basePrice: moneyDto,
  compareAtPrice: moneyDto.nullable(),
  weightGrams: z.number().int(),
  uktzedCode: z.string().nullable(),
  isActive: z.boolean(),
  isFeatured: z.boolean(),
  badge: z.enum(productBadgeValues),
  metaTitleUk: z.string().nullable(),
  metaTitleEn: z.string().nullable(),
  metaDescriptionUk: z.string().nullable(),
  metaDescriptionEn: z.string().nullable(),
  noindex: z.boolean(),
  publishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  variants: z.array(adminVariantDto),
};

export const adminProductDto = z.object(adminProductFields);
export const adminProductWithCostDto = z.object({
  ...adminProductFields,
  costPrice: moneyDto.nullable(),
});

export type AdminProductDto = z.output<typeof adminProductDto>;
export type AdminProductWithCostDto = z.output<typeof adminProductWithCostDto>;

export const adminProductRowDto = z.object({
  id: z.uuid(),
  sku: z.string(),
  slug: z.string(),
  nameUk: z.string(),
  brand: z.string(),
  categoryId: z.uuid(),
  basePrice: moneyDto,
  isActive: z.boolean(),
  variantsCount: z.number().int(),
  stockTotal: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export const adminProductRowWithCostDto = adminProductRowDto.extend({
  costPrice: moneyDto.nullable(),
});

export type AdminProductRowDto = z.output<typeof adminProductRowDto>;
export type AdminProductRowWithCostDto = z.output<typeof adminProductRowWithCostDto>;

export const adminCategoryDto = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  slug: z.string(),
  nameUk: z.string(),
  nameEn: z.string(),
  depth: z.number().int(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  sizeSystem: z.enum(sizeSystemValues).nullable(),
  noindex: z.boolean(),
});
export type AdminCategoryDto = z.output<typeof adminCategoryDto>;

/** Serialises a product for a role: with the cost only when the role may see it. */
export function serializeAdminProduct(
  value: unknown,
  canSeeCost: boolean,
): AdminProductDto | AdminProductWithCostDto {
  return canSeeCost ? adminProductWithCostDto.parse(value) : adminProductDto.parse(value);
}

export function serializeAdminProductRow(
  value: unknown,
  canSeeCost: boolean,
): AdminProductRowDto | AdminProductRowWithCostDto {
  return canSeeCost ? adminProductRowWithCostDto.parse(value) : adminProductRowDto.parse(value);
}

/** The texts of one category, for its content editor: an explicit list, no product or cost data. */
export const adminCategoryContentDto = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameUk: z.string(),
  nameEn: z.string(),
  isActive: z.boolean(),
  noindex: z.boolean(),
  descriptionUk: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  seoTextUk: z.string().nullable(),
  seoTextEn: z.string().nullable(),
  metaTitleUk: z.string().nullable(),
  metaTitleEn: z.string().nullable(),
  metaDescriptionUk: z.string().nullable(),
  metaDescriptionEn: z.string().nullable(),
});
export type AdminCategoryContentDto = z.output<typeof adminCategoryContentDto>;
