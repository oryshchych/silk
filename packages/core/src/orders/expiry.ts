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

import { DomainError } from '../errors.ts';
import { cancelOrder } from './fulfilment.ts';

export interface TransactionRunner {
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export interface ExpiryFailure {
  orderId: string;
  /** Error class name and, when the domain gave one, its code. Never the message: it may carry data. */
  name: string;
  code: string | null;
}

export interface ExpiryResult {
  expired: number;
  /** Candidates that were paid, confirmed or have an unreconciled attempt in the meantime. */
  skipped: number;
  failed: number;
  /** The caller logs these (and alerts on StockDriftError); the orders stay candidates. */
  failures: ExpiryFailure[];
}

const describeFailure = (orderId: string, error: unknown): ExpiryFailure => ({
  orderId,
  name: error instanceof Error ? error.name : 'UnknownError',
  code: error instanceof DomainError ? error.code : null,
});

/**
 * Candidates: pending, unpaid, past their TTL, and WITHOUT an attempt whose result is unknown
 * (`pending`, `in_flight` or `unknown` wait for the reconciliation job, Q27). Paged by id after the last
 * one seen, so a run of failing orders cannot hide newer expired ones behind them.
 */
export async function releaseExpiredOrders(
  runner: TransactionRunner,
  options: { batchSize?: number } = {},
): Promise<ExpiryResult> {
  const batchSize = options.batchSize ?? 200;
  const result: ExpiryResult = { expired: 0, skipped: 0, failed: 0, failures: [] };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const cursor = after;
    const candidates = await runner.transaction(async (tx) => {
      const found = await tx.execute<{ id: string }>(
        sql`SELECT o.id FROM orders o
             WHERE o.id > ${cursor}::uuid
               AND o.status = 'pending' AND o.payment_status = 'pending'
               AND EXISTS (SELECT 1 FROM stock_reservations r
                            WHERE r.order_id = o.id AND r.released_at IS NULL
                              AND r.expires_at IS NOT NULL AND r.expires_at <= now())
               AND NOT EXISTS (SELECT 1 FROM payment_attempts a
                                WHERE a.order_id = o.id AND a.state IN ('pending', 'in_flight', 'unknown'))
             ORDER BY o.id
             LIMIT ${batchSize}`,
      );
      return found.rows.map((row) => row.id);
    });
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
      } catch (error) {
        result.failed += 1;
        result.failures.push(describeFailure(orderId, error));
      }
    }
    const last = candidates.at(-1);
    if (last === undefined || candidates.length < batchSize) return result;
    after = last;
  }
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
