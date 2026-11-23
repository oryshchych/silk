/**
 * Shared SQL fragments for the public catalog. Raw `sql` is used where the
 * query builder gets in the way (EXISTS over variants, window count, JSON
 * aggregates); every result row is parsed with zod, never cast.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';

import type { Reader } from '@store/db/types';

export type SiteLocale = 'uk' | 'en';

/**
 * A product the storefront may show: active, published, a real (not gift
 * card) product, in a category whose whole ancestor chain is active (the tree
 * is at most four levels deep, see the `categories_depth_range` CHECK).
 */
export const visibleProduct = sql`(
  p.is_active AND p.kind = 'physical' AND p.published_at IS NOT NULL AND p.published_at <= now()
  AND EXISTS (
    SELECT 1 FROM categories c0
      LEFT JOIN categories c1 ON c1.id = c0.parent_id
      LEFT JOIN categories c2 ON c2.id = c1.parent_id
      LEFT JOIN categories c3 ON c3.id = c2.parent_id
     WHERE c0.id = p.category_id AND c0.is_active
       AND coalesce(c1.is_active, true) AND coalesce(c2.is_active, true) AND coalesce(c3.is_active, true)
  )
)`;

/** A variant that can be bought now: active, with unreserved stock. */
export const availableVariant = sql`(
  v.is_active AND v.stock_quantity - v.reserved_quantity > 0
)`;

/** Localised column: `localized('p', 'name', 'uk')` is `p.name_uk`. Names are fixed literals, not user input. */
export function localized(alias: string, column: string, locale: SiteLocale): SQL {
  return sql.raw(`${alias}.${column}_${locale}`);
}

export async function queryRows<S extends z.ZodType>(
  reader: Reader,
  schema: S,
  query: SQL,
): Promise<z.output<S>[]> {
  const result = await reader.execute(query);
  return result.rows.map((row) => schema.parse(row));
}
