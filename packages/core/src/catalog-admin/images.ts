/**
 * Product images (admin). The files are made and stored by `@store/media`; this is the database
 * side: the row, the alt text in both languages, the colour it belongs to, the order, deletion.
 * Storage keys are NOT stored: they are a pure function of the ids (`imageKeys`), so a file name
 * supplied by anyone can never become part of a key or a path.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { colors, productImages, products } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { listingTag, productTag, SHOWCASE_TAG } from '@store/shared/cache-tags';

import { DomainError } from '../errors.ts';
import { AdminNotFoundError } from './errors.ts';
import { diffOf, type AdminOutcome } from './outcome.ts';

export const IMAGE_SIZES = ['thumb', 'card', 'full'] as const;
export const IMAGE_FORMATS = ['webp', 'avif'] as const;
const MAX_IMAGES_PER_PRODUCT = 30;

export class TooManyImagesError extends DomainError {
  constructor() {
    super(
      'ADMIN_TOO_MANY_IMAGES',
      `A product can have at most ${String(MAX_IMAGES_PER_PRODUCT)} images`,
    );
  }
}

/** `products/<productId>/<imageId>/<size>.<format>`: ids and fixed words only. */
export const imageKey = (
  productId: string,
  imageId: string,
  size: (typeof IMAGE_SIZES)[number],
  format: (typeof IMAGE_FORMATS)[number],
): string => `products/${productId}/${imageId}/${size}.${format}`;

export const imageKeys = (productId: string, imageId: string): string[] =>
  IMAGE_SIZES.flatMap((size) =>
    IMAGE_FORMATS.map((format) => imageKey(productId, imageId, size, format)),
  );

/** Throws when the product already has the maximum number of images. */
export async function assertRoomForImage(tx: Tx | Reader, productId: string): Promise<void> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(productImages)
    .where(eq(productImages.productId, productId));
  if ((row?.n ?? 0) >= MAX_IMAGES_PER_PRODUCT) throw new TooManyImagesError();
}

export async function addProductImage(
  tx: Tx,
  input: {
    productId: string;
    imageId: string;
    /** Public URL of the main rendition (the WebP of the full size). */
    url: string;
    /** Public URL of every rendition by `<size>.<format>`. */
    variants: Record<string, string>;
    width: number;
    height: number;
  },
): Promise<AdminOutcome<{ imageId: string }>> {
  const [product] = await tx
    .select({ id: products.id, categoryId: products.categoryId })
    .from(products)
    .where(eq(products.id, input.productId));
  if (product === undefined) throw new AdminNotFoundError('product');
  await assertRoomForImage(tx, input.productId);
  const [last] = await tx
    .select({ max: sql<number>`COALESCE(max(${productImages.sortOrder}), -1)::int` })
    .from(productImages)
    .where(eq(productImages.productId, input.productId));
  await tx.insert(productImages).values({
    id: input.imageId,
    productId: input.productId,
    url: input.url,
    variants: input.variants,
    width: input.width,
    height: input.height,
    sortOrder: (last?.max ?? -1) + 1,
  });
  return {
    data: { imageId: input.imageId },
    audit: {
      action: 'create',
      entity: 'product_image',
      entityId: input.imageId,
      diff: { productId: input.productId, width: input.width, height: input.height },
    },
    tags: [productTag(input.productId), listingTag(product.categoryId), SHOWCASE_TAG],
  };
}

async function loadImage(tx: Tx, imageId: string) {
  const [row] = await tx
    .select({ image: productImages, categoryId: products.categoryId })
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .where(eq(productImages.id, imageId));
  if (row === undefined) throw new AdminNotFoundError('product');
  return row;
}

export async function updateProductImage(
  tx: Tx,
  input: {
    imageId: string;
    altUk?: string | null | undefined;
    altEn?: string | null | undefined;
    colorId?: string | null | undefined;
    sortOrder?: number | undefined;
  },
): Promise<AdminOutcome<{ changed: string[] }>> {
  const { image, categoryId } = await loadImage(tx, input.imageId);
  if (input.colorId !== undefined && input.colorId !== null) {
    const [color] = await tx
      .select({ id: colors.id })
      .from(colors)
      .where(eq(colors.id, input.colorId));
    if (color === undefined) throw new AdminNotFoundError('color');
  }
  const set = {
    ...(input.altUk === undefined ? {} : { altUk: input.altUk }),
    ...(input.altEn === undefined ? {} : { altEn: input.altEn }),
    ...(input.colorId === undefined ? {} : { colorId: input.colorId }),
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
  };
  const diff = diffOf(image, set, ['altUk', 'altEn', 'colorId', 'sortOrder']);
  if (Object.keys(diff).length > 0) {
    await tx.update(productImages).set(set).where(eq(productImages.id, input.imageId));
  }
  return {
    data: { changed: Object.keys(diff) },
    audit: { action: 'update', entity: 'product_image', entityId: input.imageId, diff },
    tags:
      Object.keys(diff).length === 0
        ? []
        : [productTag(image.productId), listingTag(categoryId), SHOWCASE_TAG],
  };
}

/** Removes the row. The files are removed by the caller AFTER the commit, from `imageKeys`. */
export async function deleteProductImage(
  tx: Tx,
  input: { imageId: string },
): Promise<AdminOutcome<{ productId: string; keys: string[] }>> {
  const { image, categoryId } = await loadImage(tx, input.imageId);
  await tx
    .delete(productImages)
    .where(and(eq(productImages.id, input.imageId), eq(productImages.productId, image.productId)));
  return {
    data: { productId: image.productId, keys: imageKeys(image.productId, image.id) },
    audit: {
      action: 'delete',
      entity: 'product_image',
      entityId: input.imageId,
      diff: { productId: image.productId },
    },
    tags: [productTag(image.productId), listingTag(categoryId), SHOWCASE_TAG],
  };
}

export interface AdminImageRow {
  id: string;
  url: string;
  thumbUrl: string;
  altUk: string | null;
  altEn: string | null;
  colorId: string | null;
  sortOrder: number;
  width: number | null;
  height: number | null;
}

export async function listAdminImages(db: Reader, productId: string): Promise<AdminImageRow[]> {
  const rows = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder), asc(productImages.id));
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    thumbUrl: row.variants?.['thumb.webp'] ?? row.url,
    altUk: row.altUk,
    altEn: row.altEn,
    colorId: row.colorId,
    sortOrder: row.sortOrder,
    width: row.width,
    height: row.height,
  }));
}
