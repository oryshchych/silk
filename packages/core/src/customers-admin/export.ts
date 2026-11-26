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

/** The last line of a file that was cut: says where the next part starts. */
export const customersTruncationLine = (cursor: string): string =>
  `# truncated: next part starts after ${cursor}`;

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
  options: { after?: string | undefined; limit?: number },
): Promise<{ csv: string; rows: number; truncated: boolean; lastEmail: string | null }> {
  const limit = options.limit ?? CUSTOMER_EXPORT_LIMIT;
  const rows = await customersForExport(db, { after: options.after, limit: limit + 1 });
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  const csv = writeCsv(
    HEADER,
    kept
      .map((row) => [
        row.email,
        row.name,
        row.phone,
        String(row.orders_count),
        toHryvniasText(money(row.ltv)),
        row.segment,
        (row.tags ?? []).join(' '),
        row.first_order_at.toISOString().slice(0, 10),
        row.last_order_at.toISOString().slice(0, 10),
      ])
      .concat(
        truncated && kept.length > 0
          ? [[customersTruncationLine(kept[kept.length - 1]?.email ?? '')]]
          : [],
      ),
  );
  return { csv, rows: kept.length, truncated, lastEmail: kept.at(-1)?.email ?? null };
}
