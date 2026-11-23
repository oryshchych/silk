/**
 * Product search: full text over the Ukrainian (hunspell) and English
 * vectors, plus trigram word similarity for typos.
 *
 * `search_vector` is filled by a trigger from `unaccent`ed text, so the query
 * is `unaccent`ed the same way. RR3: verified on the project image that
 * `unaccent` leaves й and ї alone, so -ий words still stem.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import { listingDto, type ListingDto } from '@store/shared/dto/catalog';
import { serialize } from '@store/shared/dto/serialize';

import { fetchMainImages } from './images.ts';
import { clampPage, PAGE_SIZE } from './listing-params.ts';
import { availableVariant, localized, queryRows, visibleProduct, type SiteLocale } from './sql.ts';

export const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;

const searchRow = z.object({
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
  total: z.coerce.number().int(),
});

export function normalizeSearchQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

export async function searchProducts(
  reader: Reader,
  input: { query: string; locale: SiteLocale; page: number },
): Promise<ListingDto> {
  const query = normalizeSearchQuery(input.query);
  const page = clampPage(input.page);
  const empty = { items: [], page, limit: PAGE_SIZE, total: 0, totalPages: 0 };
  if (query.length < MIN_QUERY_LENGTH) return serialize(listingDto, empty);

  // Phase 6 (search): every candidate is ranked with ts_rank and word_similarity before
  // LIMIT, so a short, common query ranks the whole match set. Cap the candidates or
  // rate-limit the route if the catalog grows well past a few thousand products.
  //
  // `<%` is word similarity (threshold 0.6), served by the GIN trigram index
  // on `search_norm`; it catches a missing or swapped letter.
  const rows = await queryRows(
    reader,
    searchRow,
    sql`WITH q AS (
          SELECT websearch_to_tsquery('ukrainian', unaccent(${query})) AS uk,
                 websearch_to_tsquery('english', unaccent(${query})) AS en,
                 lower(${query}) AS text
        )
        SELECT p.id, p.slug, ${localized('p', 'name', input.locale)} AS name, p.brand, p.base_price,
               p.compare_at_price, p.badge, p.rating_avg, p.reviews_count,
               EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND ${availableVariant}) AS in_stock,
               count(*) OVER () AS total
          FROM products p, q
         WHERE ${visibleProduct}
           AND (p.search_vector @@ q.uk OR p.search_vector @@ q.en OR q.text <% p.search_norm)
         ORDER BY ts_rank(p.search_vector, q.uk) + ts_rank(p.search_vector, q.en)
                    + word_similarity(q.text, p.search_norm) DESC,
                  p.published_at DESC, p.id
         LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
  );

  const total = rows[0]?.total ?? 0;
  const images = await fetchMainImages(
    reader,
    rows.map((row) => ({ id: row.id, name: row.name })),
    input.locale,
  );
  return serialize(listingDto, {
    items: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      brand: row.brand,
      price: row.base_price,
      compareAtPrice: row.compare_at_price,
      badge: row.badge,
      ratingAvg: row.rating_avg,
      reviewsCount: row.reviews_count,
      inStock: row.in_stock,
      image: images.get(row.id) ?? null,
    })),
    page,
    limit: PAGE_SIZE,
    total,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
}
