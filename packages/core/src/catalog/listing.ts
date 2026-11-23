/**
 * Product listing (PLP) and its filter options.
 *
 * A page costs a fixed number of queries whatever its size: one for the page
 * (window count included), one batched query for the images of the page's
 * products, plus a count only when the requested page is past the end. No
 * query runs per product (no N+1).
 *
 * Variant-level filters (band, cup, size, colour, in stock) sit in ONE
 * EXISTS, so "band 75 and cup B in black" needs a single variant that is all
 * three, not three different ones.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import {
  filterOptionsDto,
  listingDto,
  type FilterOptionsDto,
  type ListingDto,
} from '@store/shared/dto/catalog';
import { serialize } from '@store/shared/dto/serialize';

import { clampPage, PAGE_SIZE, type ListingParams } from './listing-params.ts';
import { fetchMainImages } from './images.ts';
import { availableVariant, localized, queryRows, visibleProduct, type SiteLocale } from './sql.ts';

const pageRow = z.object({
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

const inList = (items: readonly (string | number)[]): SQL =>
  sql`IN (${sql.join(
    items.map((item) => sql`${item}`),
    sql`, `,
  )})`;

function variantFilters(params: ListingParams): SQL[] {
  const filters: SQL[] = [];
  if (params.bands.length > 0) filters.push(sql`s.band ${inList(params.bands)}`);
  if (params.cups.length > 0) filters.push(sql`s.cup ${inList(params.cups)}`);
  if (params.sizes.length > 0) filters.push(sql`s.label ${inList(params.sizes)}`);
  if (params.colors.length > 0) filters.push(sql`c.slug ${inList(params.colors)}`);
  if (params.inStock) filters.push(availableVariant);
  return filters;
}

/** WHERE conditions on `products p` for a listing in `categoryIds`. */
function productFilters(categoryIds: readonly string[], params: ListingParams): SQL[] {
  const filters: SQL[] = [visibleProduct, sql`p.category_id ${inList(categoryIds)}`];
  if (params.brands.length > 0) filters.push(sql`p.brand ${inList(params.brands)}`);
  if (params.priceMin !== null) filters.push(sql`p.base_price >= ${params.priceMin}`);
  if (params.priceMax !== null) filters.push(sql`p.base_price <= ${params.priceMax}`);
  if (params.onSale) filters.push(sql`p.compare_at_price IS NOT NULL`);

  const variant = variantFilters(params);
  if (variant.length > 0) {
    filters.push(sql`EXISTS (
      SELECT 1 FROM product_variants v
        JOIN sizes s ON s.id = v.size_id
        JOIN colors c ON c.id = v.color_id
       WHERE v.product_id = p.id AND v.is_active AND ${sql.join(variant, sql` AND `)}
    )`);
  }
  return filters;
}

function orderBy(sort: ListingParams['sort']): SQL {
  switch (sort) {
    case 'price_asc':
      return sql`p.base_price ASC, p.id`;
    case 'price_desc':
      return sql`p.base_price DESC, p.id`;
    case 'discount':
      return sql`CASE WHEN p.compare_at_price IS NULL THEN 0
                 ELSE (p.compare_at_price - p.base_price)::numeric / p.compare_at_price END DESC,
                 p.published_at DESC, p.id`;
    case 'newest':
      return sql`p.published_at DESC, p.id`;
  }
}

async function countAll(reader: Reader, where: SQL): Promise<number> {
  const [row] = await queryRows(
    reader,
    z.object({ total: z.coerce.number().int() }),
    sql`SELECT count(*) AS total FROM products p WHERE ${where}`,
  );
  return row?.total ?? 0;
}

export async function listProducts(
  reader: Reader,
  input: { categoryIds: readonly string[]; params: ListingParams; locale: SiteLocale },
): Promise<ListingDto> {
  const { categoryIds, locale } = input;
  const params = { ...input.params, page: clampPage(input.params.page) };
  if (categoryIds.length === 0) {
    return serialize(listingDto, {
      items: [],
      page: params.page,
      limit: PAGE_SIZE,
      total: 0,
      totalPages: 0,
    });
  }
  const where = sql.join(productFilters(categoryIds, params), sql` AND `);

  const rows = await queryRows(
    reader,
    pageRow,
    sql`SELECT p.id, p.slug, ${localized('p', 'name', locale)} AS name, p.brand, p.base_price,
               p.compare_at_price, p.badge, p.rating_avg, p.reviews_count,
               EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND ${availableVariant}) AS in_stock,
               count(*) OVER () AS total
          FROM products p
         WHERE ${where}
         ORDER BY ${orderBy(params.sort)}
         LIMIT ${PAGE_SIZE} OFFSET ${(params.page - 1) * PAGE_SIZE}`,
  );

  // Past the last page the window count has no rows to ride on.
  const total = rows[0]?.total ?? (params.page > 1 ? await countAll(reader, where) : 0);
  const images = await fetchMainImages(
    reader,
    rows.map((row) => ({ id: row.id, name: row.name })),
    locale,
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
    page: params.page,
    limit: PAGE_SIZE,
    total,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
}

const optionsRow = z.object({ options: z.unknown() });

/** Values the filter UI can offer for a category, in one round trip. */
export async function getFilterOptions(
  reader: Reader,
  input: { categoryIds: readonly string[]; locale: SiteLocale },
): Promise<FilterOptionsDto> {
  const { categoryIds, locale } = input;
  const empty = { bands: [], cups: [], sizes: [], colors: [], brands: [], price: null };
  if (categoryIds.length === 0) return serialize(filterOptionsDto, empty);

  const [row] = await queryRows(
    reader,
    optionsRow,
    sql`WITH ps AS (
          SELECT p.id, p.brand, p.base_price FROM products p
           WHERE ${visibleProduct} AND p.category_id ${inList(categoryIds)}
        ), vs AS (
          SELECT s.system, s.label, s.band, s.cup, s.sort_order AS size_order,
                 c.slug AS color_slug, ${localized('c', 'name', locale)} AS color_name,
                 c.hex, c.sort_order AS color_order
            FROM product_variants v
            JOIN ps ON ps.id = v.product_id
            JOIN sizes s ON s.id = v.size_id
            JOIN colors c ON c.id = v.color_id
           WHERE v.is_active
        )
        SELECT json_build_object(
          'bands', coalesce((SELECT json_agg(band ORDER BY band)
                               FROM (SELECT DISTINCT band FROM vs WHERE system = 'bra') x), '[]'::json),
          'cups', coalesce((SELECT json_agg(cup ORDER BY cup)
                              FROM (SELECT DISTINCT cup FROM vs WHERE system = 'bra') x), '[]'::json),
          'sizes', coalesce((SELECT json_agg(json_build_object('label', label, 'system', system)
                                             ORDER BY system, size_order)
                               FROM (SELECT DISTINCT ON (system, label) system, label, size_order
                                       FROM vs WHERE system <> 'bra') x), '[]'::json),
          'colors', coalesce((SELECT json_agg(json_build_object('slug', color_slug, 'name', color_name, 'hex', hex)
                                              ORDER BY color_order)
                                FROM (SELECT DISTINCT ON (color_slug) color_slug, color_name, hex, color_order
                                        FROM vs) x), '[]'::json),
          'brands', coalesce((SELECT json_agg(brand ORDER BY brand)
                                FROM (SELECT DISTINCT brand FROM ps) x), '[]'::json),
          'price', (SELECT json_build_object('min', min(base_price), 'max', max(base_price))
                      FROM ps HAVING count(*) > 0)
        ) AS options`,
  );
  return serialize(filterOptionsDto, row?.options ?? empty);
}
