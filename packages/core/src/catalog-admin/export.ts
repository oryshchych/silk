/**
 * CSV export of products. The cost column exists only when the caller says the ROLE may see it
 * (`catalog.cost.view`): for any other role the column is not in the header and the value is not
 * read into the file at all. Capped, ordered by SKU, formulas neutralised (`writeCsv`).
 */
import { asc, count, eq, gt, sql } from 'drizzle-orm';

import { categories, products } from '@store/db/schema';
import type { Reader } from '@store/db/types';
import { money, toHryvniasText } from '@store/shared/money';

import { writeCsv } from './csv.ts';

export const EXPORT_LIMIT = 10_000;

const BASE_HEADER = [
  'sku',
  'slug',
  'brand',
  'category',
  'name_uk',
  'name_en',
  'price',
  'compare_at_price',
] as const;

export async function exportProductsCsv(
  db: Reader,
  options: { canSeeCost: boolean; after?: string | undefined },
): Promise<{ csv: string; rows: number; truncated: boolean; lastSku: string | null }> {
  const rows = await db
    .select({
      sku: products.sku,
      slug: products.slug,
      brand: products.brand,
      category: categories.slug,
      nameUk: products.nameUk,
      nameEn: products.nameEn,
      price: products.basePrice,
      compareAt: products.compareAtPrice,
      // Read only for a role that may see it: otherwise the value never enters this process.
      cost: options.canSeeCost ? products.costPrice : sql<number | null>`NULL::integer`,
      weight: products.weightGrams,
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(options.after === undefined ? undefined : gt(products.sku, options.after))
    .orderBy(asc(products.sku))
    .limit(EXPORT_LIMIT + 1);
  const truncated = rows.length > EXPORT_LIMIT;
  const kept = rows.slice(0, EXPORT_LIMIT);
  const header = [...BASE_HEADER, ...(options.canSeeCost ? ['cost_price'] : []), 'weight_grams'];
  const lines = kept.map((row) => [
    row.sku,
    row.slug,
    row.brand,
    row.category,
    row.nameUk,
    row.nameEn,
    toHryvniasText(money(row.price)),
    row.compareAt === null ? '' : toHryvniasText(money(row.compareAt)),
    ...(options.canSeeCost ? [row.cost === null ? '' : toHryvniasText(money(row.cost))] : []),
    String(row.weight),
  ]);
  return {
    csv: writeCsv(header, lines),
    rows: kept.length,
    truncated,
    lastSku: kept.at(-1)?.sku ?? null,
  };
}

/**
 * The parts of an export when there are more products than one file holds: for each part the SKU
 * to continue AFTER (null for the first). Empty when everything fits in one file.
 */
export async function exportParts(db: Reader): Promise<(string | null)[]> {
  const [total] = await db.select({ n: count() }).from(products);
  if ((total?.n ?? 0) <= EXPORT_LIMIT) return [];
  const parts: (string | null)[] = [null];
  for (let offset = EXPORT_LIMIT; offset < (total?.n ?? 0); offset += EXPORT_LIMIT) {
    const [boundary] = await db
      .select({ sku: products.sku })
      .from(products)
      .orderBy(asc(products.sku))
      .offset(offset - 1)
      .limit(1);
    if (boundary !== undefined) parts.push(boundary.sku);
  }
  return parts;
}
