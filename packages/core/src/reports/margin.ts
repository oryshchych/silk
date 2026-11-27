/**
 * Margin (phase 10). Cost data: ONLY callers that hold `catalog.cost.view` may call this (the
 * server action or route checks the permission BEFORE the query; the DTO is the `WithCost` shape).
 *
 * The margin is EVENT-DATED, the same philosophy as revenue (a later event lowers the later period,
 * the past is never rewritten):
 *
 *  1. Sale: an order enters the period of its FIRST capture in the payment journal (a COD order has
 *     no capture, so it has no sale and no margin until the remittance exists, Q85). Each line with a
 *     cost snapshot adds `line_total` (already net of its discount) as revenue and
 *     `unit_cost_snapshot x quantity` as cost. A line WITHOUT a snapshot is excluded from both and
 *     counted as "no cost data" (`noCostLines`, `noCostRevenue`): an unknown cost is never zero.
 *  2. Cancelled after payment: at `cancelled_at` the whole order's goods are reversed (revenue and
 *     cost of the lines that had a snapshot).
 *  3. Return received: at the FIRST receipt (`return_requests.received_at`) the received units
 *     reverse their share of the line revenue (`line_total x received / quantity`, rounded half up
 *     once) and the cost of the units put back on the shelf (`restocked_quantity`); a defective unit
 *     that is not restocked keeps its cost: the goods are lost. A return received AFTER its refund
 *     lowers the period of the receipt, not of the refund. The reversal uses the full share of the
 *     line even when the refund was smaller (a restocking fee is not modelled).
 *  4. Shipping: the carrier cost (`shipping_cost_actual`) of a sold order counts ONLY when
 *     `shipping_paid_by = 'sender'` (the tariff is not the seller's cost when the recipient paid);
 *     a seller-paid order without a recorded cost is counted in `noShippingCostOrders` and left out.
 *  5. `otherRefunds` is information, not part of the margin: settled refunds in the period that are
 *     tied to neither a received return nor a cancelled order (a goodwill refund). The margin would
 *     be overstated by exactly that money and the screen says so.
 *
 * The per-product and per-category breakdowns carry goods margin only (carrier cost cannot be
 * attributed to a product) and an "all other" row, so their sum equals the total goods margin.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import type { MarginReportDto } from '@store/shared/dto/reports';
import type { Money } from '@store/shared/money';
import { moneyFromDb, ratioBps, subtract } from '@store/shared/money';

import { capturedRows, settledRefundRows } from './revenue.ts';
import { isoUtc, lowerBound, upperBound, type Period } from './period.ts';

/** The shared CTEs: `bounds`, `first_capture`, `sold`, `events`. */
function marginCtes(from: string, to: string): SQL {
  return sql`
    bounds AS (SELECT ${lowerBound(from)} AS lo, ${upperBound(to)} AS hi),
    first_capture AS (
      SELECT a.order_id, min(a.completed_at) AS at
        FROM payment_attempts a
       WHERE ${capturedRows} AND a.completed_at IS NOT NULL
       GROUP BY a.order_id
    ),
    sold AS (
      SELECT o.id AS order_id, o.shipping_paid_by, o.shipping_cost_actual
        FROM first_capture fc JOIN orders o ON o.id = fc.order_id, bounds b
       WHERE fc.at >= b.lo AND fc.at < b.hi
    ),
    events AS (
      SELECT oi.product_uid_snapshot AS pid, oi.name_snapshot AS name,
             coalesce(oi.category_path_snapshot, '') AS category, oi.quantity::bigint AS units,
             CASE WHEN oi.unit_cost_snapshot IS NULL THEN 0 ELSE oi.line_total::bigint END AS revenue,
             CASE WHEN oi.unit_cost_snapshot IS NULL THEN 0
                  ELSE oi.unit_cost_snapshot::bigint * oi.quantity END AS cost,
             (oi.unit_cost_snapshot IS NULL) AS no_cost,
             oi.line_total::bigint AS raw_revenue
        FROM sold s JOIN order_items oi ON oi.order_id = s.order_id
      UNION ALL
      SELECT oi.product_uid_snapshot, oi.name_snapshot, coalesce(oi.category_path_snapshot, ''),
             -oi.quantity::bigint, -oi.line_total::bigint,
             -(oi.unit_cost_snapshot::bigint * oi.quantity), false, 0::bigint
        FROM orders o
        JOIN first_capture fc ON fc.order_id = o.id
        JOIN order_items oi ON oi.order_id = o.id, bounds b
       WHERE o.status = 'cancelled' AND o.cancelled_at >= b.lo AND o.cancelled_at < b.hi
         AND oi.unit_cost_snapshot IS NOT NULL
      UNION ALL
      SELECT oi.product_uid_snapshot, oi.name_snapshot, coalesce(oi.category_path_snapshot, ''),
             -rri.received_quantity::bigint,
             -((oi.line_total::bigint * rri.received_quantity * 2 + oi.quantity) / (2 * oi.quantity)),
             -(oi.unit_cost_snapshot::bigint * rri.restocked_quantity), false, 0::bigint
        FROM return_requests rr
        JOIN return_request_items rri ON rri.return_request_id = rr.id
        JOIN order_items oi ON oi.id = rri.order_item_id
        JOIN orders o ON o.id = rr.order_id
        JOIN first_capture fc ON fc.order_id = rr.order_id, bounds b
       WHERE rr.received_at >= b.lo AND rr.received_at < b.hi
         AND rri.received_quantity > 0 AND oi.unit_cost_snapshot IS NOT NULL
         AND o.status <> 'cancelled'
    )`;
}

const totalsSchema = z.object({
  now: z.string(),
  lo: z.string(),
  hi: z.string(),
  revenue: z.string(),
  cost: z.string(),
  no_cost_lines: z.coerce.number(),
  no_cost_revenue: z.string(),
  shipping_cost: z.string(),
  no_shipping_cost_orders: z.coerce.number(),
  other_refunds: z.string(),
});

export async function readMargin(db: Reader, period: Period): Promise<MarginReportDto> {
  const { from, to } = period;
  const result = await db.execute(sql`
    WITH ${marginCtes(from, to)},
    goods AS (
      SELECT coalesce(sum(revenue), 0)::text AS revenue, coalesce(sum(cost), 0)::text AS cost,
             count(*) FILTER (WHERE no_cost) AS no_cost_lines,
             coalesce(sum(raw_revenue) FILTER (WHERE no_cost), 0)::text AS no_cost_revenue
        FROM events
    ),
    ship AS (
      SELECT coalesce(sum(shipping_cost_actual) FILTER (WHERE shipping_paid_by = 'sender'), 0)::text AS cost,
             count(*) FILTER (WHERE shipping_paid_by = 'sender' AND shipping_cost_actual IS NULL) AS missing
        FROM sold
    ),
    other AS (
      SELECT coalesce(sum(r.amount), 0)::text AS amount
        FROM refund_operations r
        LEFT JOIN payment_attempts a ON a.id = r.payment_attempt_id
        JOIN orders o ON o.id = r.order_id
        LEFT JOIN return_requests rr ON rr.id = r.return_request_id, bounds b
       WHERE ${settledRefundRows} AND r.settled_at >= b.lo AND r.settled_at < b.hi
         AND o.cancelled_at IS NULL AND (rr.id IS NULL OR rr.received_at IS NULL)
    )
    SELECT ${isoUtc(sql`now()`)} AS now, ${isoUtc(sql`b.lo`)} AS lo, ${isoUtc(sql`b.hi`)} AS hi,
           g.revenue, g.cost, g.no_cost_lines, g.no_cost_revenue,
           s.cost AS shipping_cost, s.missing AS no_shipping_cost_orders, o.amount AS other_refunds
      FROM bounds b, goods g, ship s, other o
  `);
  const row = totalsSchema.parse(result.rows[0]);
  const goodsRevenue = moneyFromDb(row.revenue);
  const costOfGoods = moneyFromDb(row.cost);
  const shippingCost = moneyFromDb(row.shipping_cost);
  const margin: Money = subtract(subtract(goodsRevenue, costOfGoods), shippingCost);
  return {
    asOf: row.now,
    period: { from, to, startsAt: row.lo, endsAt: row.hi },
    totals: {
      goodsRevenue,
      costOfGoods,
      shippingCost,
      margin,
      marginBps: ratioBps(margin, goodsRevenue),
      noCostLines: row.no_cost_lines,
      noCostRevenue: moneyFromDb(row.no_cost_revenue),
      noShippingCostOrders: row.no_shipping_cost_orders,
      otherRefunds: moneyFromDb(row.other_refunds),
    },
  };
}

export const MARGIN_BREAKDOWN_LIMIT = 200;

export interface MarginRowDto {
  /** Product uid (by product) or the category path snapshot (by category). */
  key: string;
  name: string;
  units: number;
  goodsRevenue: Money;
  costOfGoods: Money;
  margin: Money;
  marginBps: number | null;
}

const breakdownSchema = z.object({
  key: z.string(),
  name: z.string(),
  units: z.coerce.number(),
  revenue: z.string(),
  cost: z.string(),
});

/**
 * Goods margin by product or by category (sold lines with a cost snapshot only), best margin first,
 * at most `limit` rows plus ONE "all other" row (`key` empty, `name` empty) so the rows add up to
 * the total goods margin to the kopiyka.
 */
export async function readMarginBreakdown(
  db: Reader,
  period: Period,
  options: { by: 'product' | 'category'; limit?: number },
): Promise<{ rows: MarginRowDto[]; rest: MarginRowDto | null }> {
  const limit = Math.min(options.limit ?? 50, MARGIN_BREAKDOWN_LIMIT);
  const keyExpr = options.by === 'product' ? sql`pid::text` : sql`category`;
  const nameExpr = options.by === 'product' ? sql`max(name)` : sql`category`;
  const result = await db.execute(sql`
    WITH ${marginCtes(period.from, period.to)},
    grouped AS (
      SELECT ${keyExpr} AS key, ${nameExpr} AS name,
             sum(units) FILTER (WHERE NOT no_cost) AS units,
             sum(revenue) AS revenue, sum(cost) AS cost
        FROM events
       GROUP BY 1
      HAVING count(*) FILTER (WHERE NOT no_cost) > 0
    )
    SELECT key, name, coalesce(units, 0)::text AS units, revenue::text AS revenue, cost::text AS cost
      FROM grouped
     ORDER BY (revenue - cost) DESC, key
  `);
  const all = result.rows.map((row) => breakdownSchema.parse(row));
  const toRow = (item: z.output<typeof breakdownSchema>): MarginRowDto => {
    const goodsRevenue = moneyFromDb(item.revenue);
    const costOfGoods = moneyFromDb(item.cost);
    const margin = subtract(goodsRevenue, costOfGoods);
    return {
      key: item.key,
      name: item.name,
      units: item.units,
      goodsRevenue,
      costOfGoods,
      margin,
      marginBps: ratioBps(margin, goodsRevenue),
    };
  };
  const rows = all.slice(0, limit).map(toRow);
  const tail = all.slice(limit);
  const rest =
    tail.length === 0
      ? null
      : toRow({
          key: '',
          name: '',
          units: tail.reduce((sum, item) => sum + item.units, 0),
          revenue: String(tail.reduce((sum, item) => sum + Number(item.revenue), 0)),
          cost: String(tail.reduce((sum, item) => sum + Number(item.cost), 0)),
        });
  return { rows, rest };
}
