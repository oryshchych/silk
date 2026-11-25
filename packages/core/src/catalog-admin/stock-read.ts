/**
 * Admin reads for the stock screen: every variant with its stock, reserved and available
 * quantities, and the history of manual changes. No cost, no price: stock is operational data
 * (`admin.view`).
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';

import {
  authUsers,
  colors,
  productVariants,
  products,
  sizes,
  stockAdjustments,
} from '@store/db/schema';
import type { Reader } from '@store/db/types';

import { LOW_STOCK_THRESHOLD, type AdminPage } from './read.ts';

export const STOCK_PAGE_SIZE = 30;

export interface StockRow {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  sizeLabel: string;
  colorName: string;
  stock: number;
  reserved: number;
  available: number;
  isActive: boolean;
}

export interface StockFilters {
  q?: string | undefined;
  /** Only variants whose available stock is at most the low-stock threshold. */
  lowOnly?: boolean | undefined;
  page?: number | undefined;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export async function listStock(db: Reader, filters: StockFilters): Promise<AdminPage<StockRow>> {
  const page = Math.max(1, Math.min(filters.page ?? 1, 10_000));
  const term = (filters.q ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, 100);
  const where = and(
    term === ''
      ? undefined
      : or(
          ilike(productVariants.sku, `%${escapeLike(term)}%`),
          ilike(products.nameUk, `%${escapeLike(term)}%`),
          ilike(products.nameEn, `%${escapeLike(term)}%`),
        ),
    filters.lowOnly === true
      ? sql`${productVariants.stockQuantity} - ${productVariants.reservedQuantity} <= ${LOW_STOCK_THRESHOLD}`
      : undefined,
  );
  const base = db
    .select({ n: sql<number>`count(*)::int` })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where);
  const [counted] = await base;
  const total = counted?.n ?? 0;
  const rows = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.nameUk,
      sku: productVariants.sku,
      sizeLabel: sizes.label,
      colorName: colors.nameUk,
      stock: productVariants.stockQuantity,
      reserved: productVariants.reservedQuantity,
      isActive: productVariants.isActive,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(sizes, eq(sizes.id, productVariants.sizeId))
    .innerJoin(colors, eq(colors.id, productVariants.colorId))
    .where(where)
    .orderBy(
      asc(sql`${productVariants.stockQuantity} - ${productVariants.reservedQuantity}`),
      asc(productVariants.sku),
    )
    .limit(STOCK_PAGE_SIZE)
    .offset((page - 1) * STOCK_PAGE_SIZE);
  return {
    items: rows.map((row) => ({ ...row, available: row.stock - row.reserved })),
    page,
    limit: STOCK_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / STOCK_PAGE_SIZE)),
  };
}

export interface StockHistoryRow {
  id: string;
  at: string;
  reason: string;
  delta: number;
  before: number;
  after: number;
  note: string | null;
  /** The email of the admin who made the change (null if unknown). */
  by: string | null;
}

export async function listStockHistory(
  db: Reader,
  variantId: string,
  limit = 20,
): Promise<StockHistoryRow[]> {
  const rows = await db
    .select({
      id: stockAdjustments.id,
      at: sql<string>`to_char(${stockAdjustments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      reason: stockAdjustments.reason,
      delta: stockAdjustments.delta,
      before: stockAdjustments.quantityBefore,
      after: stockAdjustments.quantityAfter,
      note: stockAdjustments.note,
      by: authUsers.email,
    })
    .from(stockAdjustments)
    .leftJoin(authUsers, eq(authUsers.id, stockAdjustments.userId))
    .where(eq(stockAdjustments.variantId, variantId))
    .orderBy(desc(stockAdjustments.createdAt), desc(stockAdjustments.id))
    .limit(Math.min(limit, 100));
  return rows;
}
