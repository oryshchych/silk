/**
 * Customer CSV: personal data (email, phone), so it is its own permission and every download is
 * audited by the route. Capped and ordered by email with a cursor, formulas neutralised
 * (`writeCsv`). LTV is in hryvnias with two decimals, never a float.
 */
import { money, toHryvniasText } from '@store/shared/money';
import type { Reader } from '@store/db/types';

import { writeCsv } from '../catalog-admin/csv.ts';
import { customersForExport } from './read.ts';

export const CUSTOMER_EXPORT_LIMIT = 10_000;

const HEADER = [
  'email',
  'name',
  'phone',
  'orders',
  'ltv',
  'segment',
  'tags',
  'first_order',
  'last_order',
] as const;

export async function exportCustomersCsv(
  db: Reader,
  options: { after?: string | undefined },
): Promise<{ csv: string; rows: number; truncated: boolean; lastEmail: string | null }> {
  const rows = await customersForExport(db, {
    after: options.after,
    limit: CUSTOMER_EXPORT_LIMIT + 1,
  });
  const truncated = rows.length > CUSTOMER_EXPORT_LIMIT;
  const kept = truncated ? rows.slice(0, CUSTOMER_EXPORT_LIMIT) : rows;
  const csv = writeCsv(
    HEADER,
    kept.map((row) => [
      row.email,
      row.name,
      row.phone,
      String(row.orders_count),
      toHryvniasText(money(row.ltv)),
      row.segment,
      (row.tags ?? []).join(' '),
      row.first_order_at.toISOString().slice(0, 10),
      row.last_order_at.toISOString().slice(0, 10),
    ]),
  );
  return { csv, rows: kept.length, truncated, lastEmail: kept.at(-1)?.email ?? null };
}
