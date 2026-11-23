/**
 * Worker side of ADR-3: releases the reservations of orders that were not
 * paid or confirmed in time, and the counter check that backs it up.
 *
 * The scan only picks candidates; each one is cancelled in its own
 * transaction, where `cancelOrder({ expiredOnly })` re-checks everything
 * under the order lock, so a payment that lands between scan and cancel wins.
 */
import { sql } from 'drizzle-orm';

import type { Reader, Tx } from '@store/db/types';

import { cancelOrder } from './fulfilment.ts';

export interface TransactionRunner {
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export interface ExpiryResult {
  expired: number;
  /** Candidates that were paid or confirmed in the meantime. */
  skipped: number;
  failed: number;
}

export async function releaseExpiredOrders(
  runner: TransactionRunner,
  options: { batchSize?: number } = {},
): Promise<ExpiryResult> {
  const batchSize = options.batchSize ?? 200;
  const candidates = await runner.transaction(async (tx) => {
    const found = await tx.execute<{ id: string }>(
      sql`SELECT o.id FROM orders o
           WHERE o.status = 'pending' AND o.payment_status = 'pending'
             AND EXISTS (SELECT 1 FROM stock_reservations r
                          WHERE r.order_id = o.id AND r.released_at IS NULL
                            AND r.expires_at IS NOT NULL AND r.expires_at <= now())
           ORDER BY o.created_at
           LIMIT ${batchSize}`,
    );
    return found.rows.map((row) => row.id);
  });

  const result: ExpiryResult = { expired: 0, skipped: 0, failed: 0 };
  for (const orderId of candidates) {
    try {
      const done = await runner.transaction(
        async (tx) =>
          await cancelOrder(tx, {
            orderId,
            source: 'worker:expire-unpaid',
            reason: 'reservation expired',
            expiredOnly: true,
          }),
      );
      if (done.changed) result.expired += 1;
      else result.skipped += 1;
    } catch {
      // One bad order must not stop the batch; it stays a candidate for the next run.
      result.failed += 1;
    }
  }
  return result;
}

export interface CounterDrift {
  variantId: string;
  counter: number;
  liveReservations: number;
}

/**
 * Variants whose denormalised `reserved_quantity` differs from the sum of
 * their live reservations. Reported, never corrected silently (ADR-3).
 */
export async function findReservedDrift(reader: Reader): Promise<CounterDrift[]> {
  const rows = await reader.execute<{ id: string; counter: number; live: number }>(
    sql`SELECT v.id, v.reserved_quantity AS counter,
               coalesce(sum(r.quantity), 0)::int AS live
          FROM product_variants v
          LEFT JOIN stock_reservations r ON r.variant_id = v.id AND r.released_at IS NULL
         GROUP BY v.id, v.reserved_quantity
        HAVING v.reserved_quantity <> coalesce(sum(r.quantity), 0)`,
  );
  return rows.rows.map((row) => ({
    variantId: row.id,
    counter: row.counter,
    liveReservations: row.live,
  }));
}
