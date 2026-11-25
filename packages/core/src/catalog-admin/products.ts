/**
 * Product mutations of the admin. Each takes `tx` first, checks the domain rules, and returns an
 * `AdminOutcome`: the caller (the web action) has already checked the ROLE, writes the audit row
 * and invalidates the tags after the commit. Prices and text are separate operations on purpose
 * (`catalog.price` versus `catalog.edit`): a role that may edit text cannot reach a price through
 * the same call.
 */
import { and, eq, sql } from 'drizzle-orm';

import { categories, products, productVariants } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { CATEGORIES_TAG, listingTag, productTag, SHOWCASE_TAG } from '@store/shared/cache-tags';
import { money } from '@store/shared/money';

import { DomainError } from '../errors.ts';
import { AdminNotFoundError, NotPublishableError } from './errors.ts';
import { diffOf, mapUnique, type AdminOutcome } from './outcome.ts';
import { recordSlugRedirects } from './redirects.ts';
import type { CreateProductInput, ProductContentInput, ProductPricingInput } from './schemas.ts';

export class InvalidPriceError extends DomainError {
  constructor() {
    super('ADMIN_INVALID_PRICE', 'The old price must be higher than the price');
  }
}

const productTags = (productId: string, ...categoryIds: (string | null)[]): string[] => [
  productTag(productId),
  SHOWCASE_TAG,
  ...[...new Set(categoryIds)].flatMap((id) => (id === null ? [] : [listingTag(id)])),
];

async function loadProduct(tx: Tx, productId: string) {
  const [row] = await tx.select().from(products).where(eq(products.id, productId));
  if (row === undefined) throw new AdminNotFoundError('product');
  return row;
}

async function requireCategory(tx: Tx, categoryId: string): Promise<void> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, categoryId));
  if (row === undefined) throw new AdminNotFoundError('category');
}

export async function createProduct(
  tx: Tx,
  input: CreateProductInput,
): Promise<AdminOutcome<{ productId: string }>> {
  await requireCategory(tx, input.categoryId);
  const created = await mapUnique(tx, async (inner) => {
    const [row] = await inner
      .insert(products)
      .values({
        sku: input.sku,
        slug: input.slug,
        brand: input.brand,
        categoryId: input.categoryId,
        nameUk: input.nameUk,
        nameEn: input.nameEn,
        basePrice: money(input.basePrice),
        costPrice:
          input.costPrice === undefined || input.costPrice === null ? null : money(input.costPrice),
        weightGrams: input.weightGrams,
        isActive: false,
      })
      .returning({ id: products.id });
    if (row === undefined) throw new Error('product insert returned no row');
    return row;
  });
  return {
    data: { productId: created.id },
    audit: {
      action: 'create',
      entity: 'product',
      entityId: created.id,
      // The cost is never written into a diff.
      diff: {
        sku: input.sku,
        slug: input.slug,
        categoryId: input.categoryId,
        basePrice: input.basePrice,
      },
    },
    tags: productTags(created.id, input.categoryId),
  };
}

const CONTENT_KEYS = [
  'sku',
  'slug',
  'brand',
  'categoryId',
  'nameUk',
  'nameEn',
  'shortDescriptionUk',
  'shortDescriptionEn',
  'descriptionUk',
  'descriptionEn',
  'compositionUk',
  'compositionEn',
  'careUk',
  'careEn',
  'weightGrams',
  'uktzedCode',
  'isFeatured',
  'badge',
  'metaTitleUk',
  'metaTitleEn',
  'metaDescriptionUk',
  'metaDescriptionEn',
  'noindex',
] as const;

export async function updateProductContent(
  tx: Tx,
  input: ProductContentInput,
): Promise<AdminOutcome<{ changed: string[] }>> {
  const { productId, ...fields } = input;
  const before = await loadProduct(tx, productId);
  const set = Object.fromEntries(
    CONTENT_KEYS.flatMap((key) => (fields[key] === undefined ? [] : [[key, fields[key]]])),
  );
  if (fields.categoryId !== undefined && fields.categoryId !== before.categoryId) {
    await requireCategory(tx, fields.categoryId);
  }
  const diff = diffOf(before, set, CONTENT_KEYS);
  if (Object.keys(diff).length === 0) {
    return {
      data: { changed: [] },
      audit: { action: 'update', entity: 'product', entityId: productId, diff: {} },
      tags: [],
    };
  }
  await mapUnique(tx, async (inner) => {
    await inner.update(products).set(set).where(eq(products.id, productId));
  });
  if (fields.slug !== undefined && fields.slug !== before.slug) {
    await recordSlugRedirects(tx, { kind: 'product', fromSlug: before.slug, toSlug: fields.slug });
  }
  return {
    data: { changed: Object.keys(diff) },
    audit: { action: 'update', entity: 'product', entityId: productId, diff },
    tags: productTags(productId, before.categoryId, fields.categoryId ?? null),
  };
}

export async function updateProductPricing(
  tx: Tx,
  input: ProductPricingInput,
): Promise<AdminOutcome<{ changed: string[] }>> {
  const before = await loadProduct(tx, input.productId);
  const base = input.basePrice ?? before.basePrice;
  const compare = input.compareAtPrice === undefined ? before.compareAtPrice : input.compareAtPrice;
  if (compare !== null && compare <= base) throw new InvalidPriceError();
  const set = {
    ...(input.basePrice === undefined ? {} : { basePrice: money(input.basePrice) }),
    ...(input.compareAtPrice === undefined
      ? {}
      : { compareAtPrice: input.compareAtPrice === null ? null : money(input.compareAtPrice) }),
    ...(input.costPrice === undefined
      ? {}
      : { costPrice: input.costPrice === null ? null : money(input.costPrice) }),
  };
  const diff = diffOf(before, set, ['basePrice', 'compareAtPrice', 'costPrice']);
  if (Object.keys(diff).length > 0) {
    await tx.update(products).set(set).where(eq(products.id, input.productId));
  }
  return {
    data: { changed: Object.keys(diff) },
    audit: { action: 'update', entity: 'product', entityId: input.productId, diff },
    tags: Object.keys(diff).length === 0 ? [] : productTags(input.productId, before.categoryId),
  };
}

/** Publishing needs a live category and at least one active variant; unpublishing is always allowed. */
export async function setProductActive(
  tx: Tx,
  input: { productId: string; isActive: boolean },
): Promise<AdminOutcome<{ isActive: boolean }>> {
  const before = await loadProduct(tx, input.productId);
  if (input.isActive) {
    const [category] = await tx
      .select({ isActive: categories.isActive })
      .from(categories)
      .where(eq(categories.id, before.categoryId));
    if (category?.isActive !== true) throw new NotPublishableError('inactive_category');
    const [variants] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(productVariants)
      .where(
        and(eq(productVariants.productId, input.productId), eq(productVariants.isActive, true)),
      );
    if ((variants?.n ?? 0) === 0) throw new NotPublishableError('no_active_variant');
  }
  await tx
    .update(products)
    .set({
      isActive: input.isActive,
      publishedAt: input.isActive
        ? sql`COALESCE(${products.publishedAt}, now())`
        : products.publishedAt,
    })
    .where(eq(products.id, input.productId));
  return {
    data: { isActive: input.isActive },
    audit: {
      action: 'update',
      entity: 'product',
      entityId: input.productId,
      diff: { isActive: { from: before.isActive, to: input.isActive } },
    },
    tags: [...productTags(input.productId, before.categoryId), CATEGORIES_TAG],
  };
}
