/**
 * `fiscal:reconcile` (ADR-16): orders that were paid by card, or shipped as COD, and still have no
 * issued receipt after a grace period. The job reports the count and a few ids (never buyer
 * data); a person retries them from the admin (phase 5).
 */
import { sql } from 'drizzle-orm';

import type { Reader } from '@store/db/types';

const GRACE_MINUTES = 60;

export interface ReceiptGaps {
  missing: number;
  /** A few order ids to look at first. */
  orderIds: string[];
}

export async function findReceiptGaps(reader: Reader): Promise<ReceiptGaps> {
  const rows = await reader.execute<{ id: string }>(
    sql`SELECT o.id FROM orders o
         WHERE o.fiscal_status IN ('pending', 'failed')
           AND coalesce(o.paid_at, o.shipped_at) < now() - make_interval(mins => ${GRACE_MINUTES})
         ORDER BY coalesce(o.paid_at, o.shipped_at)
         LIMIT 200`,
  );
  return { missing: rows.rows.length, orderIds: rows.rows.slice(0, 20).map((row) => row.id) };
}
