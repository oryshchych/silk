/**
 * Revenue (phase 10): THREE different quantities from the payment journal, each by the date of ITS
 * OWN operation, never from the status of an order:
 *
 *  - gross receipts: `payment_attempts.captured_amount` by `completed_at` (the capture time);
 *  - refunds: `refund_operations` in state `succeeded` by `settled_at` (the settle time);
 *  - net receipts: gross minus refunds of the same period. A refund settled in a later period than
 *    its capture lowers THAT later period (the earlier one is never rewritten), so one bucket's net
 *    can be negative.
 *
 * What counts as captured, per method: cards (mono, wayforpay): the provider confirmed `paid` and the
 * journal row carries the captured amount. Bank transfer: `confirmTransferReceived` writes a
 * `bank_transfer` attempt with the received amount when the manager confirms the bank line. Cash
 * on delivery: NOTHING until the carrier's remittance is recorded, and v1 has no way to record it
 * (`confirmCodOrder` captures nothing), so a COD order is not in these figures at all (owner queue
 * Q85). Gift cards are not revenue when sold (docs/GIFT_CARDS.md section 0, v1 sells none) and a
 * payment made with one is not a cash receipt: attempts and refunds of provider `gift_card` are
 * excluded, so a certificate can never be counted twice.
 *
 * Period boundaries and bucket edges are decided by the database in the shop time zone
 * (`period.ts`); the series and the totals come from ONE statement, so they read one snapshot.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import type {
  Granularity,
  RevenueReportDto,
  RevenuePointDto,
  RevenueTotalsDto,
} from '@store/shared/dto/reports';
import { moneyFromDb, subtract } from '@store/shared/money';

import {
  isoUtc,
  lowerBound,
  SHOP_TIMEZONE,
  STEP,
  TRUNC,
  upperBound,
  type Period,
} from './period.ts';

const TZ = sql.raw(`'${SHOP_TIMEZONE}'`);

/** The captured-money condition: ONE definition shared by the series, the totals and the dashboard. */
export const capturedRows = sql`a.captured_amount > 0 AND a.provider <> 'gift_card'`;
/** The refund condition: settled, and not a refund onto a certificate. */
export const settledRefundRows = sql`r.state = 'succeeded' AND (a.id IS NULL OR a.provider <> 'gift_card')`;

/** Cash on delivery the shop is fulfilling and has not refunded: shown, never counted (Q85). */
export const codRows = sql`o.payment_provider = 'cod'
  AND o.status IN ('confirmed', 'processing', 'shipped', 'delivered') AND o.refunded_total = 0`;

const rowSchema = z.object({
  now: z.string(),
  lo: z.string(),
  hi: z.string(),
  series: z.array(
    z.object({
      bucket: z.string(),
      gross: z.string(),
      refunds: z.string(),
    }),
  ),
  totals: z.object({
    gross: z.string(),
    refunds: z.string(),
    captures: z.coerce.number(),
    refund_ops: z.coerce.number(),
    untimed_captures: z.coerce.number(),
    untimed_refunds: z.coerce.number(),
    cod_orders: z.coerce.number(),
    cod_total: z.string(),
  }),
});

export async function readRevenue(db: Reader, period: Period): Promise<RevenueReportDto> {
  const { from, to, granularity } = period;
  const result = await db.execute(sql`
    WITH bounds AS (SELECT ${lowerBound(from)} AS lo, ${upperBound(to)} AS hi),
    buckets AS (
      SELECT g::date AS bucket
        FROM generate_series(
               date_trunc(${TRUNC[granularity]}, ${from}::date::timestamp),
               ${to}::date::timestamp,
               ${STEP[granularity]}) AS g
    ),
    gross AS (
      SELECT date_trunc(${TRUNC[granularity]}, a.completed_at AT TIME ZONE ${TZ})::date AS bucket,
             sum(a.captured_amount)::text AS v
        FROM payment_attempts a, bounds b
       WHERE ${capturedRows} AND a.completed_at >= b.lo AND a.completed_at < b.hi
       GROUP BY 1
    ),
    refunds AS (
      SELECT date_trunc(${TRUNC[granularity]}, r.settled_at AT TIME ZONE ${TZ})::date AS bucket,
             sum(r.amount)::text AS v
        FROM refund_operations r
        LEFT JOIN payment_attempts a ON a.id = r.payment_attempt_id, bounds b
       WHERE ${settledRefundRows} AND r.settled_at >= b.lo AND r.settled_at < b.hi
       GROUP BY 1
    ),
    series AS (
      SELECT to_char(k.bucket, 'YYYY-MM-DD') AS bucket,
             coalesce(g.v, '0') AS gross, coalesce(f.v, '0') AS refunds
        FROM buckets k
        LEFT JOIN gross g ON g.bucket = k.bucket
        LEFT JOIN refunds f ON f.bucket = k.bucket
       ORDER BY k.bucket
    ),
    totals AS (
      SELECT
        (SELECT coalesce(sum(a.captured_amount), 0)::text FROM payment_attempts a, bounds b
          WHERE ${capturedRows} AND a.completed_at >= b.lo AND a.completed_at < b.hi) AS gross,
        (SELECT coalesce(sum(r.amount), 0)::text FROM refund_operations r
           LEFT JOIN payment_attempts a ON a.id = r.payment_attempt_id, bounds b
          WHERE ${settledRefundRows} AND r.settled_at >= b.lo AND r.settled_at < b.hi) AS refunds,
        (SELECT count(*) FROM payment_attempts a, bounds b
          WHERE ${capturedRows} AND a.completed_at >= b.lo AND a.completed_at < b.hi) AS captures,
        (SELECT count(*) FROM refund_operations r
           LEFT JOIN payment_attempts a ON a.id = r.payment_attempt_id, bounds b
          WHERE ${settledRefundRows} AND r.settled_at >= b.lo AND r.settled_at < b.hi) AS refund_ops,
        (SELECT count(*) FROM payment_attempts a
          WHERE ${capturedRows} AND a.completed_at IS NULL) AS untimed_captures,
        (SELECT count(*) FROM refund_operations r
           LEFT JOIN payment_attempts a ON a.id = r.payment_attempt_id
          WHERE ${settledRefundRows} AND r.settled_at IS NULL) AS untimed_refunds,
        (SELECT count(*) FROM orders o, bounds b
          WHERE ${codRows} AND o.created_at >= b.lo AND o.created_at < b.hi) AS cod_orders,
        (SELECT coalesce(sum(o.total::bigint), 0)::text FROM orders o, bounds b
          WHERE ${codRows} AND o.created_at >= b.lo AND o.created_at < b.hi) AS cod_total
    )
    SELECT ${isoUtc(sql`now()`)} AS now, ${isoUtc(sql`b.lo`)} AS lo, ${isoUtc(sql`b.hi`)} AS hi,
           (SELECT coalesce(json_agg(s ORDER BY s.bucket), '[]'::json) FROM series s) AS series,
           (SELECT row_to_json(t) FROM totals t) AS totals
      FROM bounds b
  `);
  const row = rowSchema.parse(result.rows[0]);
  const series: RevenuePointDto[] = row.series.map((point) => {
    const gross = moneyFromDb(point.gross);
    const refunds = moneyFromDb(point.refunds);
    return { bucket: point.bucket, gross, refunds, net: subtract(gross, refunds) };
  });
  const gross = moneyFromDb(row.totals.gross);
  const refunds = moneyFromDb(row.totals.refunds);
  const totals: RevenueTotalsDto = {
    gross,
    refunds,
    net: subtract(gross, refunds),
    captures: row.totals.captures,
    refundOperations: row.totals.refund_ops,
    untimedCaptures: row.totals.untimed_captures,
    untimedRefunds: row.totals.untimed_refunds,
    codNotIncluded: { orders: row.totals.cod_orders, total: moneyFromDb(row.totals.cod_total) },
  };
  return {
    asOf: row.now,
    period: { from, to, startsAt: row.lo, endsAt: row.hi },
    granularity: granularity satisfies Granularity,
    series,
    totals,
  };
}
