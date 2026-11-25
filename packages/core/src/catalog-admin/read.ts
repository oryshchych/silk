/**
 * Admin reads. Never cached (ADR-8: the editor must see their own change at once) and always
 * serialised through the DTO schemas of `@store/shared/dto/admin-catalog`, picked by whether the
 * ROLE may see the cost. The row from the database carries `cost_price`; for a role that may not
 * see it the schema has no such key, so it cannot leave the server.
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';

import {
  attributes,
  attributeValues,
  categories,
  colors,
  productAttributeValues,
  products,
  productVariants,
  sizes,
} from '@store/db/schema';
import type { Reader } from '@store/db/types';
import {
  adminCategoryDto,
  serializeAdminProduct,
  serializeAdminProductRow,
  type AdminCategoryDto,
  type AdminProductDto,
  type AdminProductRowDto,
  type AdminProductRowWithCostDto,
  type AdminProductWithCostDto,
} from '@store/shared/dto/admin-catalog';

export const ADMIN_PAGE_SIZE = 25;
const MAX_QUERY = 100;
export const LOW_STOCK_THRESHOLD = 3;

export interface AdminProductFilters {
  q?: string | undefined;
  categoryId?: string | undefined;
  isActive?: boolean | undefined;
  /** Only products with at least one active variant whose available stock is at most the threshold. */
  lowStock?: boolean | undefined;
  page?: number | undefined;
}

export interface AdminPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** `%`, `_` and `\` in a search term are literal characters, not wildcards. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export async function listAdminProducts(
  db: Reader,
  filters: AdminProductFilters,
  canSeeCost: boolean,
): Promise<AdminPage<AdminProductRowDto | AdminProductRowWithCostDto>> {
  const page = Math.max(1, Math.min(filters.page ?? 1, 10_000));
  const term = (filters.q ?? '').trim().slice(0, MAX_QUERY);
  const conditions = [
    term === ''
      ? undefined
      : or(
          ilike(products.sku, `%${escapeLike(term)}%`),
          ilike(products.nameUk, `%${escapeLike(term)}%`),
          ilike(products.nameEn, `%${escapeLike(term)}%`),
          ilike(products.brand, `%${escapeLike(term)}%`),
        ),
    filters.categoryId === undefined ? undefined : eq(products.categoryId, filters.categoryId),
    filters.isActive === undefined ? undefined : eq(products.isActive, filters.isActive),
    filters.lowStock === true
      ? sql`EXISTS (SELECT 1 FROM product_variants lv
                    WHERE lv.product_id = ${products.id} AND lv.is_active
                      AND lv.stock_quantity - lv.reserved_quantity <= ${LOW_STOCK_THRESHOLD})`
      : undefined,
  ].filter((condition) => condition !== undefined);
  const where = conditions.length === 0 ? undefined : and(...conditions);

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(where);
  const total = counted?.total ?? 0;
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      slug: products.slug,
      nameUk: products.nameUk,
      brand: products.brand,
      categoryId: products.categoryId,
      basePrice: products.basePrice,
      costPrice: products.costPrice,
      isActive: products.isActive,
      variantsCount: sql<number>`(SELECT count(*)::int FROM product_variants v WHERE v.product_id = ${products.id})`,
      stockTotal: sql<number>`(SELECT COALESCE(sum(v.stock_quantity), 0)::int FROM product_variants v WHERE v.product_id = ${products.id})`,
      updatedAt: sql<string>`to_char(${products.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(products)
    .where(where)
    .orderBy(desc(products.updatedAt), asc(products.id))
    .limit(ADMIN_PAGE_SIZE)
    .offset((page - 1) * ADMIN_PAGE_SIZE);
  return {
    items: rows.map((row) => serializeAdminProductRow(row, canSeeCost)),
    page,
    limit: ADMIN_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE)),
  };
}

export async function getAdminProduct(
  db: Reader,
  productId: string,
  canSeeCost: boolean,
): Promise<AdminProductDto | AdminProductWithCostDto | null> {
  const [product] = await db
    .select({
      product: products,
      updatedAt: sql<string>`to_char(${products.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      publishedAt: sql<
        string | null
      >`to_char(${products.publishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(products)
    .where(eq(products.id, productId));
  if (product === undefined) return null;
  const variants = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      sizeId: productVariants.sizeId,
      sizeLabel: sizes.label,
      colorId: productVariants.colorId,
      colorName: colors.nameUk,
      priceOverride: productVariants.priceOverride,
      stockQuantity: productVariants.stockQuantity,
      reservedQuantity: productVariants.reservedQuantity,
      isActive: productVariants.isActive,
    })
    .from(productVariants)
    .innerJoin(sizes, eq(sizes.id, productVariants.sizeId))
    .innerJoin(colors, eq(colors.id, productVariants.colorId))
    .where(eq(productVariants.productId, productId))
    .orderBy(asc(colors.sortOrder), asc(sizes.sortOrder), asc(productVariants.sku));
  return serializeAdminProduct(
    {
      ...product.product,
      updatedAt: product.updatedAt,
      publishedAt: product.publishedAt,
      variants,
    },
    canSeeCost,
  );
}

export async function listAdminCategories(db: Reader): Promise<AdminCategoryDto[]> {
  const rows = await db
    .select({
      id: categories.id,
      parentId: categories.parentId,
      slug: categories.slug,
      nameUk: categories.nameUk,
      nameEn: categories.nameEn,
      depth: categories.depth,
      sortOrder: categories.sortOrder,
      isActive: categories.isActive,
      sizeSystem: categories.sizeSystem,
      noindex: categories.noindex,
    })
    .from(categories)
    .orderBy(asc(categories.depth), asc(categories.sortOrder), asc(categories.slug));
  return rows.map((row) => adminCategoryDto.parse(row));
}

export interface AdminSizeOption {
  id: string;
  system: string;
  label: string;
}

export interface AdminColorOption {
  id: string;
  name: string;
  hex: string;
}

export async function listAdminSizes(db: Reader): Promise<AdminSizeOption[]> {
  return await db
    .select({ id: sizes.id, system: sizes.system, label: sizes.label })
    .from(sizes)
    .orderBy(asc(sizes.system), asc(sizes.sortOrder), asc(sizes.label));
}

export async function listAdminColors(db: Reader): Promise<AdminColorOption[]> {
  return await db
    .select({ id: colors.id, name: colors.nameUk, hex: colors.hex })
    .from(colors)
    .orderBy(asc(colors.sortOrder), asc(colors.nameUk));
}

export interface AdminColorFull {
  id: string;
  slug: string;
  nameUk: string;
  nameEn: string;
  hex: string;
  sortOrder: number;
}

export interface AdminSizeFull {
  id: string;
  system: 'bra' | 'panty' | 'apparel' | 'onesize';
  label: string;
  band: number | null;
  cup: string | null;
  euLabel: string | null;
  usLabel: string | null;
  sortOrder: number;
}

export interface AdminAttributeFull {
  id: string;
  code: string;
  nameUk: string;
  nameEn: string;
  type: 'select' | 'multiselect' | 'boolean' | 'text';
  isFilterable: boolean;
  sortOrder: number;
  values: { id: string; slug: string; valueUk: string; valueEn: string; sortOrder: number }[];
}

export async function listAdminColorsFull(db: Reader): Promise<AdminColorFull[]> {
  return await db
    .select({
      id: colors.id,
      slug: colors.slug,
      nameUk: colors.nameUk,
      nameEn: colors.nameEn,
      hex: colors.hex,
      sortOrder: colors.sortOrder,
    })
    .from(colors)
    .orderBy(asc(colors.sortOrder), asc(colors.slug));
}

export async function listAdminSizesFull(db: Reader): Promise<AdminSizeFull[]> {
  return await db
    .select({
      id: sizes.id,
      system: sizes.system,
      label: sizes.label,
      band: sizes.band,
      cup: sizes.cup,
      euLabel: sizes.euLabel,
      usLabel: sizes.usLabel,
      sortOrder: sizes.sortOrder,
    })
    .from(sizes)
    .orderBy(asc(sizes.system), asc(sizes.sortOrder), asc(sizes.label));
}

export async function listAdminAttributes(db: Reader): Promise<AdminAttributeFull[]> {
  const attrs = await db
    .select()
    .from(attributes)
    .orderBy(asc(attributes.sortOrder), asc(attributes.code));
  const values = await db
    .select()
    .from(attributeValues)
    .orderBy(asc(attributeValues.sortOrder), asc(attributeValues.slug));
  return attrs.map((attribute) => ({
    id: attribute.id,
    code: attribute.code,
    nameUk: attribute.nameUk,
    nameEn: attribute.nameEn,
    type: attribute.type,
    isFilterable: attribute.isFilterable,
    sortOrder: attribute.sortOrder,
    values: values
      .filter((value) => value.attributeId === attribute.id)
      .map((value) => ({
        id: value.id,
        slug: value.slug,
        valueUk: value.valueUk,
        valueEn: value.valueEn,
        sortOrder: value.sortOrder,
      })),
  }));
}

/** The attribute value ids assigned to a product. */
export async function listProductAttributeValueIds(
  db: Reader,
  productId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: productAttributeValues.attributeValueId })
    .from(productAttributeValues)
    .where(eq(productAttributeValues.productId, productId));
  return rows.map((row) => row.id);
}
