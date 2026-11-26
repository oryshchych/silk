/**
 * Orders for the accountant: one row per order in a date range (Kyiv days), amounts in hryvnias
 * with two decimals (`toHryvniasText`, never a float), no email, no phone and no cost. Capped and
 * ordered by order number with a cursor; formulas neutralised (`writeCsv`). Money columns:
 * `received` is what payments captured, `refunded` what went back, so a cancelled-and-refunded
 * order nets to zero in the sheet.
 */
import { and, asc, gt, gte, lt, sql } from 'drizzle-orm';

import { orders } from '@store/db/schema';
import type { Reader } from '@store/db/types';
import { money, toHryvniasText } from '@store/shared/money';

import { writeCsv } from '../catalog-admin/csv.ts';

export const ORDER_EXPORT_LIMIT = 10_000;

/** The last line of a file that was cut: says where the next part starts (a person never sees the headers). */
export const truncationLine = (cursor: string): string =>
  `# truncated: next part starts after ${cursor}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (value: string): boolean => {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const HEADER = [
  'number',
  'date',
  'status',
  'payment_status',
  'payment_method',
  'delivery',
  'subtotal',
  'discount',
  'shipping',
  'adjustment',
  'total',
  'received',
  'refunded',
  'fiscal_status',
  'fiscal_receipt',
  'waybill',
] as const;

export class ExportRangeError extends Error {
  constructor() {
    super('the range needs two real days, from not after to');
    this.name = 'ExportRangeError';
  }
}

export async function exportOrdersCsv(
  db: Reader,
  options: { from: string; to: string; after?: string | undefined; limit?: number },
): Promise<{ csv: string; rows: number; truncated: boolean; lastNumber: string | null }> {
  if (!isRealDay(options.from) || !isRealDay(options.to) || options.from > options.to) {
    throw new ExportRangeError();
  }
  const limit = options.limit ?? ORDER_EXPORT_LIMIT;
  const rows = await db
    .select({
      number: orders.orderNumber,
      day: sql<string>`to_char(${orders.createdAt} AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      provider: orders.paymentProvider,
      delivery: orders.deliveryMethod,
      subtotal: orders.subtotal,
      discount: orders.discountTotal,
      shipping: orders.shippingTotal,
      adjustment: orders.adjustmentTotal,
      total: orders.total,
      captured: orders.capturedTotal,
      refunded: orders.refundedTotal,
      fiscal: orders.fiscalStatus,
      receipt: orders.fiscalReceiptId,
      ttn: orders.ttn,
    })
    .from(orders)
    .where(
      and(
        gte(orders.createdAt, sql`(${options.from}::date)::timestamp AT TIME ZONE 'Europe/Kyiv'`),
        lt(
          orders.createdAt,
          sql`((${options.to}::date + 1)::timestamp) AT TIME ZONE 'Europe/Kyiv'`,
        ),
        options.after === undefined ? undefined : gt(orders.orderNumber, options.after),
      ),
    )
    .orderBy(asc(orders.orderNumber))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  const csv = writeCsv(
    HEADER,
    kept
      .map((row) => [
        row.number,
        row.day,
        row.status,
        row.paymentStatus,
        row.provider ?? '',
        row.delivery,
        toHryvniasText(money(row.subtotal)),
        toHryvniasText(money(row.discount)),
        toHryvniasText(money(row.shipping)),
        toHryvniasText(money(row.adjustment)),
        toHryvniasText(money(row.total)),
        toHryvniasText(money(row.captured)),
        toHryvniasText(money(row.refunded)),
        row.fiscal,
        row.receipt ?? '',
        row.ttn ?? '',
      ])
      .concat(
        truncated && kept.length > 0 ? [[truncationLine(kept[kept.length - 1]?.number ?? '')]] : [],
      ),
  );
  return { csv, rows: kept.length, truncated, lastNumber: kept.at(-1)?.number ?? null };
}
