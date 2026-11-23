/**
 * Home page showcases: the newest products and the bestsellers. A short fixed
 * list per kind, so one query plus one batched image query, and nothing the
 * client chooses reaches SQL (the kind is a closed set, the limit is clamped).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import { productCardDto, type ProductCardDto } from '@store/shared/dto/catalog';
import { serialize } from '@store/shared/dto/serialize';

import { fetchMainImages } from './images.ts';
import { availableVariant, localized, queryRows, visibleProduct, type SiteLocale } from './sql.ts';

export const SHOWCASE_KINDS = ['new', 'bestseller'] as const;
export type ShowcaseKind = (typeof SHOWCASE_KINDS)[number];

const MAX_SHOWCASE = 24;

const row = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  brand: z.string(),
  base_price: z.number().int(),
  compare_at_price: z.number().int().nullable(),
  badge: z.enum(['none', 'new', 'sale', 'bestseller', 'last_units']),
  rating_avg: z.number().nullable(),
  reviews_count: z.number().int(),
  in_stock: z.boolean(),
});

export async function listShowcase(
  reader: Reader,
  input: { kind: ShowcaseKind; limit: number; locale: SiteLocale },
): Promise<ProductCardDto[]> {
  const limit = Number.isInteger(input.limit)
    ? Math.min(Math.max(input.limit, 1), MAX_SHOWCASE)
    : 8;
  // Bestsellers are the products the shop marked `bestseller`; the newest come first in both lists.
  const kindFilter = input.kind === 'bestseller' ? sql`AND p.badge = 'bestseller'` : sql``;

  const rows = await queryRows(
    reader,
    row,
    sql`SELECT p.id, p.slug, ${localized('p', 'name', input.locale)} AS name, p.brand, p.base_price,
               p.compare_at_price, p.badge, p.rating_avg, p.reviews_count,
               EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND ${availableVariant}) AS in_stock
          FROM products p
         WHERE ${visibleProduct} ${kindFilter}
         ORDER BY p.published_at DESC, p.id
         LIMIT ${limit}`,
  );

  const images = await fetchMainImages(
    reader,
    rows.map((item) => ({ id: item.id, name: item.name })),
    input.locale,
  );
  return rows.map((item) =>
    serialize(productCardDto, {
      id: item.id,
      slug: item.slug,
      name: item.name,
      brand: item.brand,
      price: item.base_price,
      compareAtPrice: item.compare_at_price,
      badge: item.badge,
      ratingAvg: item.rating_avg,
      reviewsCount: item.reviews_count,
      inStock: item.in_stock,
      image: images.get(item.id) ?? null,
    }),
  );
}
