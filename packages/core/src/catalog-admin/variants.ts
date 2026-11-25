import { and, eq, inArray } from 'drizzle-orm';

import { colors, products, productVariants, sizes } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { listingTag, productTag, SHOWCASE_TAG } from '@store/shared/cache-tags';
import { money } from '@store/shared/money';

import { AdminNotFoundError, TooManyVariantsError } from './errors.ts';
import { diffOf, mapUnique, type AdminOutcome } from './outcome.ts';

const MAX_GENERATED = 200;

/** `PRODUCT-COLOR-SIZE`, upper case, only characters a SKU may hold. */
export const variantSku = (productSku: string, colorSlug: string, sizeLabel: string): string =>
  `${productSku}-${colorSlug}-${sizeLabel}`
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);

/**
 * The variants matrix: every (size, colour) pair that does not exist yet becomes an active variant
 * with zero stock (stock is set through `adjustStock`, with history). Existing pairs are left
 * alone, so the generator can be run again after adding a size.
 */
export async function generateVariants(
  tx: Tx,
  input: { productId: string; sizeIds: string[]; colorIds: string[] },
): Promise<AdminOutcome<{ created: number; skipped: number }>> {
  const sizeIds = [...new Set(input.sizeIds)];
  const colorIds = [...new Set(input.colorIds)];
  if (sizeIds.length * colorIds.length > MAX_GENERATED) throw new TooManyVariantsError();
  const [product] = await tx.select().from(products).where(eq(products.id, input.productId));
  if (product === undefined) throw new AdminNotFoundError('product');
  const sizeRows = await tx.select().from(sizes).where(inArray(sizes.id, sizeIds));
  const colorRows = await tx.select().from(colors).where(inArray(colors.id, colorIds));
  if (sizeRows.length !== sizeIds.length) throw new AdminNotFoundError('size');
  if (colorRows.length !== colorIds.length) throw new AdminNotFoundError('color');

  const values = sizeRows.flatMap((size) =>
    colorRows.map((color) => ({
      productId: product.id,
      sizeId: size.id,
      colorId: color.id,
      sku: variantSku(product.sku, color.slug, size.label),
    })),
  );
  const inserted = await mapUnique(
    tx,
    async (inner) =>
      await inner
        .insert(productVariants)
        .values(values)
        .onConflictDoNothing({
          target: [productVariants.productId, productVariants.sizeId, productVariants.colorId],
        })
        .returning({ id: productVariants.id }),
  );
  return {
    data: { created: inserted.length, skipped: values.length - inserted.length },
    audit: {
      action: 'create',
      entity: 'product_variant',
      entityId: product.id,
      diff: { sizes: sizeIds.length, colors: colorIds.length, created: inserted.length },
    },
    tags: [productTag(product.id), listingTag(product.categoryId), SHOWCASE_TAG],
  };
}

async function loadVariant(tx: Tx, variantId: string) {
  const [row] = await tx
    .select({ variant: productVariants, categoryId: products.categoryId })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, variantId));
  if (row === undefined) throw new AdminNotFoundError('variant');
  return row;
}

export async function updateVariantContent(
  tx: Tx,
  input: {
    variantId: string;
    sku?: string | undefined;
    barcode?: string | null | undefined;
    isActive?: boolean | undefined;
    weightGrams?: number | null | undefined;
  },
): Promise<AdminOutcome<{ changed: string[] }>> {
  const { variant, categoryId } = await loadVariant(tx, input.variantId);
  const set = {
    ...(input.sku === undefined ? {} : { sku: input.sku }),
    ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.weightGrams === undefined ? {} : { weightGrams: input.weightGrams }),
  };
  const diff = diffOf(variant, set, ['sku', 'barcode', 'isActive', 'weightGrams']);
  if (Object.keys(diff).length > 0) {
    await mapUnique(tx, async (inner) => {
      await inner.update(productVariants).set(set).where(eq(productVariants.id, input.variantId));
    });
  }
  return {
    data: { changed: Object.keys(diff) },
    audit: { action: 'update', entity: 'product_variant', entityId: input.variantId, diff },
    tags:
      Object.keys(diff).length === 0
        ? []
        : [productTag(variant.productId), listingTag(categoryId), SHOWCASE_TAG],
  };
}

export async function updateVariantPricing(
  tx: Tx,
  input: { variantId: string; priceOverride: number | null },
): Promise<AdminOutcome<{ changed: boolean }>> {
  const { variant, categoryId } = await loadVariant(tx, input.variantId);
  const next = input.priceOverride === null ? null : money(input.priceOverride);
  const changed = variant.priceOverride !== next;
  if (changed) {
    await tx
      .update(productVariants)
      .set({ priceOverride: next })
      .where(and(eq(productVariants.id, input.variantId)));
  }
  return {
    data: { changed },
    audit: {
      action: 'update',
      entity: 'product_variant',
      entityId: input.variantId,
      diff: changed ? { priceOverride: { from: variant.priceOverride, to: next } } : {},
    },
    tags: changed ? [productTag(variant.productId), listingTag(categoryId), SHOWCASE_TAG] : [],
  };
}
