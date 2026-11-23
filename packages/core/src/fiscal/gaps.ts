/**
 * `fiscal:reconcile` (ADR-16): orders that were paid by card, or shipped as COD, and still have no
 * issued receipt after a grace period, plus open return receipts. It checks OUR records only
 * (documents and statuses); matching the acquirer's settlement against receipts is a later job. The job reports the count and a few ids (never buyer
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
  const grace = sql`make_interval(mins => ${GRACE_MINUTES})`;
  const rows = await reader.execute<{ id: string }>(
    sql`SELECT o.id FROM orders o
         WHERE
           -- a sale receipt that is queued, in trouble or failed
           (o.fiscal_status IN ('pending', 'failed')
              AND coalesce(o.paid_at, o.shipped_at) < now() - ${grace})
           -- a card order paid without ANY issued sale receipt (never queued: paid before this
           -- code, or by a path that forgot enqueueSaleReceipt): it still says not_required
           OR (o.payment_status = 'paid' AND o.payment_provider IN ('mono', 'wayforpay')
              AND o.paid_at < now() - ${grace}
              AND NOT EXISTS (SELECT 1 FROM fiscal_documents d
                               WHERE d.order_id = o.id AND d.kind = 'sale' AND d.state = 'succeeded'))
           -- a return receipt that is not done after the grace period
           OR EXISTS (SELECT 1 FROM fiscal_documents d
                       WHERE d.order_id = o.id AND d.kind = 'return'
                         AND d.state IN ('pending', 'in_flight', 'unknown', 'failed')
                         AND d.created_at < now() - ${grace})
         ORDER BY o.created_at
         LIMIT 200`,
  );
  return { missing: rows.rows.length, orderIds: rows.rows.slice(0, 20).map((row) => row.id) };
}
