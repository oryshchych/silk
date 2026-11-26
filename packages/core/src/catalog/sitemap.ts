/**
 * Rows for the sitemaps (phase 6). Only what a visitor can reach and a search engine may index:
 * the same `visibleProduct` rule as the storefront, minus `noindex`. The columns are an explicit
 * list (slug and last change), nothing else leaves this module.
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

export async function countSitemapProducts(reader: Reader): Promise<number> {
  const [first] = await queryRows(
    reader,
    z.object({ n: z.coerce.number().int() }),
    sql`SELECT count(*) AS n FROM products p WHERE ${visibleProduct} AND NOT p.noindex`,
  );
  return first?.n ?? 0;
}

/** Slug of the first product of file `fileIndex`, or null past the end. */
export async function sitemapFileStart(
  reader: Reader,
  fileIndex: number,
  perFile: number,
): Promise<string | null> {
  const [first] = await queryRows(
    reader,
    z.object({ slug: z.string() }),
    sql`SELECT p.slug FROM products p WHERE ${visibleProduct} AND NOT p.noindex
         ORDER BY p.slug OFFSET ${fileIndex * perFile} LIMIT 1`,
  );
  return first?.slug ?? null;
}

/** A keyset page: products with `slug >= from`, in slug order. */
export async function listSitemapProducts(
  reader: Reader,
  from: string,
  limit: number,
): Promise<SitemapRow[]> {
  return await queryRows(
    reader,
    row,
    sql`SELECT p.slug, to_char(p.updated_at AT TIME ZONE 'UTC', ${UTC_STAMP}) AS lastmod
          FROM products p
         WHERE ${visibleProduct} AND NOT p.noindex AND p.slug >= ${from}
         ORDER BY p.slug LIMIT ${limit}`,
  );
}

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
         WHERE c0.is_active AND NOT c0.noindex
           AND coalesce(c1.is_active, true) AND coalesce(c2.is_active, true) AND coalesce(c3.is_active, true)
         ORDER BY c0.slug LIMIT 5000`,
  );
}
