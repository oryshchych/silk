/**
 * A small catalogue for the content readiness tests: every product is COMPLETE unless the test
 * overrides one thing, so each failure class is one override. Texts are built from the key, so no
 * two products share a meta text by accident.
 */
import { sql } from 'drizzle-orm';

import {
  categories,
  colors,
  productImages,
  productVariants,
  products,
  sizes,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { imageKey, IMAGE_FORMATS, IMAGE_SIZES } from '../src/catalog-admin/images.ts';

/** `n` characters of readable filler starting with the seed (unique per seed, never shorter than the seed). */
export function filler(seed: string, n: number): string {
  const base = `${seed} `;
  return base.repeat(Math.ceil(n / base.length)).slice(0, n);
}

export const SEO_TEXT = (locale: string): string => `<p>${filler(`seo ${locale}`, 400)}</p>`;

export interface CatalogIds {
  categoryId: string;
  hiddenCategoryId: string;
  emptyCategoryId: string;
  colorId: string;
  sizeId: string;
  size2Id: string;
}

export async function seedDictionaries(tx: Tx): Promise<CatalogIds> {
  const cat = async (
    slug: string,
    extra: Partial<typeof categories.$inferInsert> = {},
  ): Promise<string> => {
    const [row] = await tx
      .insert(categories)
      .values({
        slug,
        nameUk: `Категорія ${slug}`,
        nameEn: `Category ${slug}`,
        seoTextUk: SEO_TEXT('uk'),
        seoTextEn: SEO_TEXT('en'),
        ...extra,
      })
      .returning({ id: categories.id });
    if (row === undefined) throw new Error('category');
    return row.id;
  };
  const categoryId = await cat('ready-cat');
  const hiddenCategoryId = await cat('hidden-cat', { isActive: false });
  const emptyCategoryId = await cat('empty-cat', { seoTextUk: null, seoTextEn: null });
  const [color] = await tx
    .insert(colors)
    .values({ slug: 'black', nameUk: 'Чорний', nameEn: 'Black', hex: '#101010' })
    .returning({ id: colors.id });
  const [size] = await tx
    .insert(sizes)
    .values({ system: 'apparel', label: 'S' })
    .returning({ id: sizes.id });
  const [size2] = await tx
    .insert(sizes)
    .values({ system: 'apparel', label: 'M' })
    .returning({ id: sizes.id });
  if (color === undefined || size === undefined || size2 === undefined) throw new Error('dict');
  return {
    categoryId,
    hiddenCategoryId,
    emptyCategoryId,
    colorId: color.id,
    sizeId: size.id,
    size2Id: size2.id,
  };
}

export interface ProductSpec {
  key: string;
  categoryId: string;
  product?: Partial<typeof products.$inferInsert>;
  /** Stock of the single variant; `null`: no variant at all. */
  stock?: number | null;
  variantActive?: boolean;
  barcode?: string | null;
  /** Photos: default one good photo; `[]` none. */
  images?: readonly ImageSpec[];
}

export interface ImageSpec {
  altUk?: string | null;
  altEn?: string | null;
  width?: number;
  height?: number;
  /** Drop one rendition from `variants`, e.g. `card.avif`. */
  without?: string;
  url?: string;
}

let barcodeSeed = 4_006_381_330_000;

export const GOOD_ALT = { uk: 'Бюстгальтер чорний, вид спереду', en: 'Black bra, front view' };

export async function addProduct(tx: Tx, ids: CatalogIds, spec: ProductSpec): Promise<string> {
  const { key } = spec;
  const [row] = await tx
    .insert(products)
    .values({
      sku: `SKU-${key}`,
      slug: `item-${key}`,
      brand: 'Aurelia',
      categoryId: spec.categoryId,
      nameUk: `Бюстгальтер ${key}`,
      nameEn: `Bra ${key}`,
      shortDescriptionUk: filler(`коротко ${key}`, 60),
      shortDescriptionEn: filler(`short ${key}`, 60),
      descriptionUk: filler(`опис ${key}`, 200),
      descriptionEn: filler(`description ${key}`, 200),
      compositionUk: `Бавовна 95%, еластан 5% (${key})`,
      compositionEn: `Cotton 95%, elastane 5% (${key})`,
      careUk: `Прання при 30 °C (${key})`,
      careEn: `Wash at 30 °C (${key})`,
      metaTitleUk: filler(`Заголовок ${key}`, 45),
      metaTitleEn: filler(`Title ${key}`, 45),
      metaDescriptionUk: filler(`Опис для пошуку ${key}`, 120),
      metaDescriptionEn: filler(`Search description ${key}`, 120),
      basePrice: 129_900,
      costPrice: 4_242_424,
      isActive: true,
      publishedAt: sql`now() - interval '1 day'`,
      ...spec.product,
    })
    .returning({ id: products.id });
  if (row === undefined) throw new Error('product');
  if (spec.stock !== null) {
    await tx.insert(productVariants).values({
      productId: row.id,
      sizeId: ids.sizeId,
      colorId: ids.colorId,
      sku: `V-${key}`,
      stockQuantity: spec.stock ?? 5,
      isActive: spec.variantActive ?? true,
      barcode: spec.barcode === undefined ? String((barcodeSeed += 1)) : spec.barcode,
    });
  }
  const images = spec.images ?? [{}];
  let order = 0;
  for (const image of images) {
    const imageId = crypto.randomUUID();
    const variants: Record<string, string> = {};
    for (const size of IMAGE_SIZES) {
      for (const format of IMAGE_FORMATS) {
        const name = `${size}.${format}`;
        if (name !== image.without)
          variants[name] = `https://media.example.test/${imageKey(row.id, imageId, size, format)}`;
      }
    }
    await tx.insert(productImages).values({
      id: imageId,
      productId: row.id,
      url: image.url ?? variants['full.webp'] ?? '',
      variants,
      altUk: image.altUk === undefined ? GOOD_ALT.uk : image.altUk,
      altEn: image.altEn === undefined ? GOOD_ALT.en : image.altEn,
      width: image.width ?? 1200,
      height: image.height ?? 1500,
      sortOrder: order,
    });
    order += 1;
  }
  return row.id;
}
