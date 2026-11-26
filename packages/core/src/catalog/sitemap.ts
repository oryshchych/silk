/**
 * Rows for the sitemaps (phase 6). Only what a visitor can reach and a search engine may index:
 * the same `visibleProduct` rule as the storefront, minus `noindex`, and only slugs the storefront
 * can serve (the proxy refuses any other spelling with a 404, so listing one would be a dead URL).
 * The columns are an explicit list (slug and last change), nothing else leaves this module.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';

import { queryRows, visibleProduct } from './sql.ts';

export interface SitemapRow {
  slug: string;
  /** UTC `YYYY-MM-DDTHH:MM:SSZ`, formatted by the database so no driver Date handling is involved. */
  lastmod: string;
}

const row = z.object({ slug: z.string(), lastmod: z.string() });
const UTC_STAMP = sql`'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;
/** Same shape as `isProductSlug` (the proxy gate). */
const SERVABLE_SLUG = sql`'^[a-z0-9]+(-[a-z0-9]+)*$'`;

const listable = sql`${visibleProduct} AND NOT p.noindex AND p.slug ~ ${SERVABLE_SLUG}`;

/**
 * The first slug of every product file, in slug order: file `n` is `[starts[n], starts[n + 1])`.
 * One query, so the split is consistent; the caller caches it with the index.
 */
export async function sitemapFileStarts(reader: Reader, perFile: number): Promise<string[]> {
  const rows = await queryRows(
    reader,
    z.object({ slug: z.string() }),
    sql`SELECT t.slug FROM (
          SELECT p.slug, row_number() OVER (ORDER BY p.slug) AS rn
            FROM products p WHERE ${listable}
        ) t
         WHERE (t.rn - 1) % ${perFile} = 0
         ORDER BY t.rn`,
  );
  return rows.map((r) => r.slug);
}

/** A keyset page of one file: `from <= slug < until` (`until` null: to the end), in slug order. */
export async function listSitemapProducts(
  reader: Reader,
  range: { from: string; until: string | null },
  limit: number,
): Promise<SitemapRow[]> {
  return await queryRows(
    reader,
    row,
    sql`SELECT p.slug, to_char(p.updated_at AT TIME ZONE 'UTC', ${UTC_STAMP}) AS lastmod
          FROM products p
         WHERE ${listable} AND p.slug >= ${range.from}
           AND (${range.until}::text IS NULL OR p.slug < ${range.until}::text)
         ORDER BY p.slug LIMIT ${limit}`,
  );
}

/** At most this many categories go into `pages.xml`; a catalog this size needs a split first. */
export const SITEMAP_CATEGORY_LIMIT = 5_000;

/** Active categories whose whole ancestor chain is active, minus `noindex` ones. */
export async function listSitemapCategories(reader: Reader): Promise<SitemapRow[]> {
  return await queryRows(
    reader,
    row,
    sql`SELECT c0.slug, to_char(c0.updated_at AT TIME ZONE 'UTC', ${UTC_STAMP}) AS lastmod
          FROM categories c0
          LEFT JOIN categories c1 ON c1.id = c0.parent_id
          LEFT JOIN categories c2 ON c2.id = c1.parent_id
          LEFT JOIN categories c3 ON c3.id = c2.parent_id
         WHERE c0.is_active AND NOT c0.noindex AND c0.slug ~ ${SERVABLE_SLUG}
           AND coalesce(c1.is_active, true) AND coalesce(c2.is_active, true) AND coalesce(c3.is_active, true)
         ORDER BY c0.slug LIMIT ${SITEMAP_CATEGORY_LIMIT}`,
  );
}
