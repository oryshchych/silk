/**
 * The promo-code list as CSV: the same rows, filters and numbers as the screen (one query), capped,
 * formulas neutralised by `writeCsv`. Amounts are hryvnias with two decimals from integer kopiykas.
 */
import { money, toHryvniasText } from '@store/shared/money';

import { writeCsv } from '../catalog-admin/csv.ts';
import type { ReportDb } from '../reports/transaction.ts';
import { listPromoCodes, type PromoFilters } from './read.ts';

export const PROMO_EXPORT_LIMIT = 5_000;

const HEADER = [
  'code',
  'description',
  'type',
  'value',
  'status',
  'uses_consumed',
  'max_uses',
  'discount_total',
  'captured_total',
  'starts_at',
  'ends_at',
  'created_at',
] as const;

export async function exportPromoCodesCsv(
  db: ReportDb,
  filters: PromoFilters,
): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const page = await listPromoCodes(db, { ...filters, page: 1 }, false, PROMO_EXPORT_LIMIT);
  const csv = writeCsv(
    HEADER,
    page.items.map((row) => [
      row.code,
      row.description ?? '',
      row.type,
      row.type === 'fixed' ? toHryvniasText(money(row.value)) : String(row.value),
      row.status,
      String(row.consumedCount),
      row.maxUses === null ? '' : String(row.maxUses),
      toHryvniasText(row.discountTotal),
      toHryvniasText(row.capturedTotal),
      row.startsAt ?? '',
      row.endsAt ?? '',
      row.createdAt,
    ]),
  );
  return { csv, rows: page.items.length, truncated: page.total > page.items.length };
}
