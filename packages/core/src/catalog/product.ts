/**
 * Product page data. A constant number of queries (product, images, variants,
 * attributes, category tree), independent of how many variants it has.
 *
 * What leaves this module is `productDetailDto`: no cost price, no stock or
 * reserved counts (only `available` / `lastUnits`), no search vector.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import { productDetailDto, type ProductDetailDto } from '@store/shared/dto/catalog';
import { serialize } from '@store/shared/dto/serialize';

import { getCategoryTrail } from './categories.ts';
import { availableVariant, localized, queryRows, visibleProduct, type SiteLocale } from './sql.ts';

/** At or below this many unreserved units a variant is flagged `lastUnits`. */
export const LAST_UNITS_THRESHOLD = 3;

const badge = z.enum(['none', 'new', 'sale', 'bestseller', 'last_units']);

const productRow = z.object({
  id: z.uuid(),
  slug: z.string(),
  sku: z.string(),
  brand: z.string(),
  category_id: z.uuid(),
  name: z.string(),
  short_description: z.string().nullable(),
  description: z.string().nullable(),
  composition: z.string().nullable(),
  care: z.string().nullable(),
  base_price: z.number().int(),
  compare_at_price: z.number().int().nullable(),
  badge,
  rating_avg: z.number().nullable(),
  reviews_count: z.number().int(),
  meta_title: z.string().nullable(),
  meta_description: z.string().nullable(),
  og_image_url: z.string().nullable(),
  noindex: z.boolean(),
});

const imageRow = z.object({
  url: z.string(),
  alt: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  color_slug: z.string().nullable(),
});

const variantRow = z.object({
  id: z.uuid(),
  size_label: z.string(),
  size_system: z.enum(['bra', 'panty', 'apparel', 'onesize']),
  band: z.number().int().nullable(),
  cup: z.string().nullable(),
  color_slug: z.string(),
  color_name: z.string(),
  color_hex: z.string(),
  price: z.number().int(),
  available: z.boolean(),
  last_units: z.boolean(),
});

const attributeRow = z.object({
  code: z.string(),
  name: z.string(),
  value_slug: z.string(),
  value: z.string(),
});

function groupAttributes(
  rows: readonly z.output<typeof attributeRow>[],
): ProductDetailDto['attributes'] {
  const groups = new Map<string, ProductDetailDto['attributes'][number]>();
  for (const row of rows) {
    const group = groups.get(row.code) ?? { code: row.code, name: row.name, values: [] };
    group.values.push({ slug: row.value_slug, value: row.value });
    groups.set(row.code, group);
  }
  return [...groups.values()];
}

function distinctColors(rows: readonly z.output<typeof variantRow>[]): ProductDetailDto['colors'] {
  const colors = new Map<string, ProductDetailDto['colors'][number]>();
  for (const row of rows) {
    if (!colors.has(row.color_slug)) {
      colors.set(row.color_slug, {
        slug: row.color_slug,
        name: row.color_name,
        hex: row.color_hex,
      });
    }
  }
  return [...colors.values()];
}

/**
 * Id and category of a visible product by slug: a cheap lookup that lets the
 * caller tag the cached product read with `product:{id}` and `category:{id}`
 * (cache tags must be known when the cache is created).
 */
export async function getProductRef(
  reader: Reader,
  slug: string,
): Promise<{ id: string; categoryId: string } | null> {
  const [row] = await queryRows(
    reader,
    z.object({ id: z.uuid(), category_id: z.uuid() }),
    sql`SELECT p.id, p.category_id FROM products p WHERE p.slug = ${slug} AND ${visibleProduct}`,
  );
  return row === undefined ? null : { id: row.id, categoryId: row.category_id };
}

export async function getProductBySlug(
  reader: Reader,
  slug: string,
  locale: SiteLocale,
): Promise<ProductDetailDto | null> {
  const [product] = await queryRows(
    reader,
    productRow,
    sql`SELECT p.id, p.slug, p.sku, p.brand, p.category_id,
               ${localized('p', 'name', locale)} AS name,
               ${localized('p', 'short_description', locale)} AS short_description,
               ${localized('p', 'description', locale)} AS description,
               ${localized('p', 'composition', locale)} AS composition,
               ${localized('p', 'care', locale)} AS care,
               p.base_price, p.compare_at_price, p.badge, p.rating_avg, p.reviews_count,
               ${localized('p', 'meta_title', locale)} AS meta_title,
               ${localized('p', 'meta_description', locale)} AS meta_description,
               p.og_image_url, p.noindex
          FROM products p
         WHERE p.slug = ${slug} AND ${visibleProduct}`,
  );
  if (product === undefined) return null;

  const images = await queryRows(
    reader,
    imageRow,
    sql`SELECT i.url, ${localized('i', 'alt', locale)} AS alt, i.width, i.height, c.slug AS color_slug
          FROM product_images i
          LEFT JOIN colors c ON c.id = i.color_id
         WHERE i.product_id = ${product.id}
         ORDER BY i.sort_order, i.id`,
  );
  const variants = await queryRows(
    reader,
    variantRow,
    sql`SELECT v.id, s.label AS size_label, s.system AS size_system, s.band, s.cup,
               c.slug AS color_slug, ${localized('c', 'name', locale)} AS color_name, c.hex AS color_hex,
               coalesce(v.price_override, ${product.base_price}) AS price,
               ${availableVariant} AS available,
               (v.is_active AND v.stock_quantity - v.reserved_quantity BETWEEN 1 AND ${LAST_UNITS_THRESHOLD}) AS last_units
          FROM product_variants v
          JOIN sizes s ON s.id = v.size_id
          JOIN colors c ON c.id = v.color_id
         WHERE v.product_id = ${product.id} AND v.is_active
         ORDER BY c.sort_order, s.sort_order, v.id`,
  );
  const attributes = await queryRows(
    reader,
    attributeRow,
    sql`SELECT a.code, ${localized('a', 'name', locale)} AS name, av.slug AS value_slug,
               ${localized('av', 'value', locale)} AS value
          FROM product_attribute_values pav
          JOIN attribute_values av ON av.id = pav.attribute_value_id
          JOIN attributes a ON a.id = av.attribute_id
         WHERE pav.product_id = ${product.id}
         ORDER BY a.sort_order, a.code, av.sort_order`,
  );
  const trail = await getCategoryTrail(reader, product.category_id, locale);
  const category = trail.at(-1);
  // The category is inactive (or gone): the product page is not reachable either.
  if (category === undefined) return null;

  return serialize(productDetailDto, {
    id: product.id,
    slug: product.slug,
    sku: product.sku,
    brand: product.brand,
    name: product.name,
    shortDescription: product.short_description,
    description: product.description,
    composition: product.composition,
    care: product.care,
    price: product.base_price,
    compareAtPrice: product.compare_at_price,
    badge: product.badge,
    ratingAvg: product.rating_avg,
    reviewsCount: product.reviews_count,
    metaTitle: product.meta_title,
    metaDescription: product.meta_description,
    ogImageUrl: product.og_image_url,
    noindex: product.noindex,
    category,
    breadcrumbs: trail,
    images: images.map((image) => ({
      url: image.url,
      alt: image.alt ?? product.name,
      width: image.width,
      height: image.height,
      colorSlug: image.color_slug,
    })),
    colors: distinctColors(variants),
    variants: variants.map((variant) => ({
      id: variant.id,
      sizeLabel: variant.size_label,
      sizeSystem: variant.size_system,
      band: variant.band,
      cup: variant.cup,
      colorSlug: variant.color_slug,
      price: variant.price,
      available: variant.available,
      lastUnits: variant.last_units,
    })),
    attributes: groupAttributes(attributes),
  });
}
