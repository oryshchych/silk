/**
 * Rows for the product feeds (phase 6): one row per active variant of a product the storefront
 * shows (same `visibleProduct` rule, minus `noindex`, servable slugs only). Ukrainian text, the
 * shop's primary language. The column list is explicit: no cost price, no stock counts (only
 * whether the variant can be bought), nothing a feed must not carry.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';

import { safeMediaUrl } from './media-url.ts';
import { availableVariant, queryRows, visibleProduct } from './sql.ts';

export interface FeedVariantRow {
  variantId: string;
  sku: string;
  barcode: string | null;
  productId: string;
  slug: string;
  brand: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  /** Integer kopiykas: the price of THIS variant, and the product's crossed-out price. */
  price: number;
  compareAtPrice: number | null;
  size: string;
  color: string;
  available: boolean;
  /** Root-first category path, e.g. `Білизна > Бюстгальтери`. */
  category: string;
  /** The photo of the variant's colour when there is one, else the product's first. */
  image: string | null;
  additionalImages: string[];
}

const row = z.object({
  variant_id: z.uuid(),
  sku: z.string(),
  barcode: z.string().nullable(),
  product_id: z.uuid(),
  slug: z.string(),
  brand: z.string(),
  name: z.string(),
  short_description: z.string().nullable(),
  description: z.string().nullable(),
  price: z.number().int(),
  compare_at_price: z.number().int().nullable(),
  size: z.string(),
  color: z.string(),
  available: z.boolean(),
  category: z.string(),
  image: z.string().nullable(),
  additional: z.array(z.string()),
});

const SERVABLE_SLUG = sql`'^[a-z0-9]+(-[a-z0-9]+)*$'`;
/** Photos of this variant's colour first, then the product's own order. */
const PHOTO_ORDER = sql`(i.color_id IS NOT DISTINCT FROM v.color_id) DESC, i.sort_order, i.id`;

/** Most photos beyond the main one a feed item carries (Google allows 10). */
export const FEED_ADDITIONAL_IMAGES = 10;

/** A keyset page of variants after `after` (a variant id; null: from the start), in id order. */
export async function listFeedVariants(
  reader: Reader,
  after: string | null,
  limit: number,
): Promise<FeedVariantRow[]> {
  const rows = await queryRows(
    reader,
    row,
    sql`SELECT v.id AS variant_id, v.sku, v.barcode, p.id AS product_id, p.slug, p.brand,
               p.name_uk AS name, p.short_description_uk AS short_description,
               p.description_uk AS description,
               coalesce(v.price_override, p.base_price) AS price, p.compare_at_price,
               s.label AS size, col.name_uk AS color, ${availableVariant} AS available,
               concat_ws(' > ', c3.name_uk, c2.name_uk, c1.name_uk, c0.name_uk) AS category,
               (SELECT i.url FROM product_images i WHERE i.product_id = p.id
                 ORDER BY ${PHOTO_ORDER} LIMIT 1) AS image,
               to_json(ARRAY(SELECT i.url FROM product_images i WHERE i.product_id = p.id
                 ORDER BY ${PHOTO_ORDER} OFFSET 1 LIMIT ${FEED_ADDITIONAL_IMAGES})) AS additional
          FROM product_variants v
          JOIN products p ON p.id = v.product_id
          JOIN sizes s ON s.id = v.size_id
          JOIN colors col ON col.id = v.color_id
          JOIN categories c0 ON c0.id = p.category_id
          LEFT JOIN categories c1 ON c1.id = c0.parent_id
          LEFT JOIN categories c2 ON c2.id = c1.parent_id
          LEFT JOIN categories c3 ON c3.id = c2.parent_id
         WHERE v.is_active AND ${visibleProduct} AND NOT p.noindex AND p.slug ~ ${SERVABLE_SLUG}
           AND (${after}::uuid IS NULL OR v.id > ${after}::uuid)
         ORDER BY v.id LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    variantId: r.variant_id,
    sku: r.sku,
    barcode: r.barcode,
    productId: r.product_id,
    slug: r.slug,
    brand: r.brand,
    name: r.name,
    shortDescription: r.short_description,
    description: r.description,
    price: r.price,
    compareAtPrice: r.compare_at_price,
    size: r.size,
    color: r.color,
    available: r.available,
    category: r.category,
    image: safeMediaUrl(r.image),
    additionalImages: r.additional.flatMap((url) => {
      const safe = safeMediaUrl(url);
      return safe === null ? [] : [safe];
    }),
  }));
}
