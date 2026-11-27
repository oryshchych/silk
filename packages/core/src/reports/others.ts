/**
 * The reports that carry no cost: orders, top products, stock, returns, promo codes, customers,
 * payment providers and "viewed but not bought". Each returns the shared tabular form (`ReportResultDto`)
 * so the screen and the CSV are two renderings of ONE result. Orders-based reports date an order by
 * its creation day in the shop zone; money reports (revenue, customers, providers) date by the
 * journal operation. A report that lists rows is cut at a stated cap while its totals row covers
 * everything. Nothing here selects a cost column except the stock report, and only when the caller
 * passes `includeCost`, which the permission check owns.
 *
 * NOT a funnel: the views report lists products with views and no purchase in the period, it never
 * divides views by anything and nothing here is called conversion (plan, phase 10).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import type { ReportCell, ReportResultDto } from '@store/shared/dto/reports';
import { moneyFromDb, ratioBps } from '@store/shared/money';

import { isoUtc, lowerBound, upperBound, type Period } from './period.ts';
import { capturedRows, settledRefundRows } from './revenue.ts';

export const ROW_CAP = 100;
export const STOCK_ROW_CAP = 500;

const bounds = (period: Period) =>
  sql`bounds AS (SELECT ${lowerBound(period.from)} AS lo, ${upperBound(period.to)} AS hi)`;

const nowAndBounds = (period: Period) => sql`
  SELECT ${isoUtc(sql`now()`)} AS now, ${isoUtc(lowerBound(period.from))} AS lo, ${isoUtc(upperBound(period.to))} AS hi`;

const metaSchema = z.object({ now: z.string(), lo: z.string(), hi: z.string() });

async function meta(db: Reader, period: Period) {
  const result = await db.execute(nowAndBounds(period));
  const row = metaSchema.parse(result.rows[0]);
  return {
    asOf: row.now,
    period: { from: period.from, to: period.to, startsAt: row.lo, endsAt: row.hi },
  };
}

const num = (value: string | number): number => Number(value);
const str = z.string();
const int = z.coerce.number().int();

/* ─────────────────────────────── orders ─────────────────────────────── */

const ordersRow = z.object({ dim: str, value: str, n: int, amount: str });

export async function readOrdersReport(db: Reader, period: Period): Promise<ReportResultDto> {
  const info = await meta(db, period);
  const dims = (column: ReturnType<typeof sql.raw>, label: string) => sql`
    SELECT ${label}::text AS dim, ${column}::text AS value, count(*)::text AS n,
           coalesce(sum(o.total), 0)::text AS amount
      FROM orders o, bounds b
     WHERE o.created_at >= b.lo AND o.created_at < b.hi
     GROUP BY 2`;
  const result = await db.execute(sql`
    WITH ${bounds(period)}
    ${dims(sql.raw('o.status'), 'status')}
    UNION ALL ${dims(sql.raw('o.delivery_method'), 'delivery')}
    UNION ALL ${dims(sql.raw(`coalesce(o.payment_provider::text, 'none')`), 'payment')}
    UNION ALL SELECT 'all', '', count(*)::text, coalesce(sum(o.total), 0)::text
      FROM orders o, bounds b WHERE o.created_at >= b.lo AND o.created_at < b.hi
    ORDER BY 1, 2`);
  const all = result.rows.map((row) => ordersRow.parse(row));
  const total = all.find((row) => row.dim === 'all');
  return {
    name: 'orders',
    ...info,
    table: {
      columns: [
        { key: 'dimension', kind: 'text' },
        { key: 'value', kind: 'text' },
        { key: 'orders', kind: 'int' },
        { key: 'amount', kind: 'money' },
      ],
      rows: all
        .filter((row) => row.dim !== 'all')
        .map((row) => [row.dim, row.value, row.n, moneyFromDb(row.amount)]),
      totals: ['all', '', total?.n ?? 0, moneyFromDb(total?.amount ?? '0')],
      truncated: false,
    },
    facts: [],
    chart: null,
    notes: ['ordersByCreation'],
  };
}

/* ───────────────────────────── top products ───────────────────────────── */

const topRow = z.object({ key: str, name: str, units: str, revenue: str });

export async function readTopProducts(
  db: Reader,
  period: Period,
  sort: 'units' | 'revenue',
): Promise<ReportResultDto> {
  const info = await meta(db, period);
  const order =
    sort === 'units' ? sql`sum(oi.quantity) DESC, 1` : sql`sum(oi.line_total::bigint) DESC, 1`;
  const result = await db.execute(sql`
    WITH ${bounds(period)}
    SELECT oi.product_uid_snapshot::text AS key, max(oi.name_snapshot) AS name,
           sum(oi.quantity)::text AS units, sum(oi.line_total::bigint)::text AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id, bounds b
     WHERE o.created_at >= b.lo AND o.created_at < b.hi AND o.status <> 'cancelled'
     GROUP BY 1 ORDER BY ${order} LIMIT ${ROW_CAP + 1}`);
  const rows = result.rows.map((row) => topRow.parse(row));
  const totals = await db.execute(sql`
    WITH ${bounds(period)}
    SELECT coalesce(sum(oi.quantity), 0)::text AS units, coalesce(sum(oi.line_total::bigint), 0)::text AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id, bounds b
     WHERE o.created_at >= b.lo AND o.created_at < b.hi AND o.status <> 'cancelled'`);
  const t = z.object({ units: str, revenue: str }).parse(totals.rows[0]);
  return {
    name: 'top-products',
    ...info,
    table: {
      columns: [
        { key: 'product', kind: 'text' },
        { key: 'name', kind: 'text' },
        { key: 'units', kind: 'int' },
        { key: 'revenue', kind: 'money' },
      ],
      rows: rows
        .slice(0, ROW_CAP)
        .map((row) => [row.key, row.name, num(row.units), moneyFromDb(row.revenue)]),
      totals: ['', '', num(t.units), moneyFromDb(t.revenue)],
      truncated: rows.length > ROW_CAP,
    },
    facts: [],
    chart: null,
    notes: ['ordersByCreation', 'notRevenue'],
  };
}

/* ─────────────────────────────── stock ─────────────────────────────── */

const stockRow = z.object({
  sku: str,
  name: str,
  stock: int,
  reserved: int,
  available: int,
  price: str,
  cost: z.string().nullable(),
});

export async function readStockReport(
  db: Reader,
  options: { threshold: number; includeCost: boolean },
): Promise<ReportResultDto> {
  const asOf = z
    .object({ now: z.string() })
    .parse((await db.execute(sql`SELECT ${isoUtc(sql`now()`)} AS now`)).rows[0]).now;
  const live = sql`v.is_active AND p.is_active AND p.kind = 'physical'`;
  const result = await db.execute(sql`
    SELECT v.sku, p.name_uk AS name, v.stock_quantity AS stock, v.reserved_quantity AS reserved,
           (v.stock_quantity - v.reserved_quantity) AS available,
           coalesce(v.price_override, p.base_price)::text AS price,
           ${options.includeCost ? sql`p.cost_price::text` : sql`NULL::text`} AS cost
      FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE ${live} AND (v.stock_quantity - v.reserved_quantity) <= ${options.threshold}
     ORDER BY available, v.sku LIMIT ${STOCK_ROW_CAP + 1}`);
  const rows = result.rows.map((row) => stockRow.parse(row));
  const totals = await db.execute(sql`
    SELECT coalesce(sum(coalesce(v.price_override, p.base_price)::bigint * v.stock_quantity), 0)::text AS at_price,
           ${options.includeCost ? sql`coalesce(sum(p.cost_price::bigint * v.stock_quantity), 0)::text` : sql`'0'`} AS at_cost,
           ${options.includeCost ? sql`count(*) FILTER (WHERE p.cost_price IS NULL AND v.stock_quantity > 0)::text` : sql`'0'`} AS no_cost,
           count(*)::text AS variants,
           count(*) FILTER (WHERE (v.stock_quantity - v.reserved_quantity) <= ${options.threshold})::text AS low
      FROM product_variants v JOIN products p ON p.id = v.product_id WHERE ${live}`);
  const t = z
    .object({ at_price: str, at_cost: str, no_cost: str, variants: str, low: str })
    .parse(totals.rows[0]);
  const columns: ReportResultDto['table']['columns'] = [
    { key: 'sku', kind: 'text' },
    { key: 'name', kind: 'text' },
    { key: 'stock', kind: 'int' },
    { key: 'reserved', kind: 'int' },
    { key: 'available', kind: 'int' },
    { key: 'price', kind: 'money' },
  ];
  const facts: ReportResultDto['facts'] = [
    { key: 'variants', kind: 'int', value: num(t.variants) },
    { key: 'lowVariants', kind: 'int', value: num(t.low) },
    { key: 'stockValueAtPrice', kind: 'money', value: moneyFromDb(t.at_price) },
  ];
  const notes = ['stockNow'];
  if (options.includeCost) {
    columns.push({ key: 'cost', kind: 'money' });
    facts.push({ key: 'stockValueAtCost', kind: 'money', value: moneyFromDb(t.at_cost) });
    facts.push({ key: 'noCostVariants', kind: 'int', value: num(t.no_cost) });
  }
  return {
    name: 'stock',
    asOf,
    period: null,
    table: {
      columns,
      rows: rows.slice(0, STOCK_ROW_CAP).map((row): ReportCell[] => {
        const cells: ReportCell[] = [
          row.sku,
          row.name,
          row.stock,
          row.reserved,
          row.available,
          moneyFromDb(row.price),
        ];
        if (options.includeCost) cells.push(row.cost === null ? null : moneyFromDb(row.cost));
        return cells;
      }),
      totals: null,
      truncated: rows.length > STOCK_ROW_CAP,
    },
    facts,
    chart: null,
    notes,
  };
}

/* ─────────────────────────────── returns ─────────────────────────────── */

const returnRow = z.object({
  reason: str,
  requests: str,
  received: str,
  refunded: str,
  amount: str,
});

export async function readReturnsReport(db: Reader, period: Period): Promise<ReportResultDto> {
  const info = await meta(db, period);
  const result = await db.execute(sql`
    WITH ${bounds(period)}
    SELECT rr.reason::text AS reason, count(*)::text AS requests,
           (count(*) FILTER (WHERE rr.received_at IS NOT NULL))::text AS received,
           (count(*) FILTER (WHERE ro.id IS NOT NULL))::text AS refunded,
           coalesce(sum(ro.amount), 0)::text AS amount
      FROM return_requests rr
      LEFT JOIN refund_operations ro ON ro.id = rr.refund_operation_id AND ro.state = 'succeeded', bounds b
     WHERE rr.created_at >= b.lo AND rr.created_at < b.hi
     GROUP BY 1 ORDER BY count(*) DESC, 1`);
  const rows = result.rows.map((row) => returnRow.parse(row));
  const paid = await db.execute(sql`
    WITH ${bounds(period)},
    first_capture AS (
      SELECT a.order_id, min(a.completed_at) AS at FROM payment_attempts a
       WHERE ${capturedRows} AND a.completed_at IS NOT NULL GROUP BY a.order_id)
    SELECT count(*)::text AS n FROM first_capture fc, bounds b WHERE fc.at >= b.lo AND fc.at < b.hi`);
  const paidOrders = num(z.object({ n: str }).parse(paid.rows[0]).n);
  const sumOf = (pick: (r: (typeof rows)[number]) => string) =>
    rows.reduce((acc, row) => acc + num(pick(row)), 0);
  const requests = sumOf((r) => r.requests);
  return {
    name: 'returns',
    ...info,
    table: {
      columns: [
        { key: 'reason', kind: 'text' },
        { key: 'requests', kind: 'int' },
        { key: 'received', kind: 'int' },
        { key: 'refunded', kind: 'int' },
        { key: 'refundAmount', kind: 'money' },
      ],
      rows: rows.map((r) => [
        r.reason,
        num(r.requests),
        num(r.received),
        num(r.refunded),
        moneyFromDb(r.amount),
      ]),
      totals: [
        '',
        requests,
        sumOf((r) => r.received),
        sumOf((r) => r.refunded),
        moneyFromDb(String(sumOf((r) => r.amount))),
      ],
      truncated: false,
    },
    facts: [
      { key: 'paidOrders', kind: 'int', value: paidOrders },
      { key: 'returnRate', kind: 'bps', value: ratioBps(requests, paidOrders) },
    ],
    chart: null,
    notes: ['returnRateCohort'],
  };
}

/* ──────────────────────────────── promos ──────────────────────────────── */

const promoRow = z.object({ code: str, orders: str, discount: str, total: str });

export async function readPromosReport(db: Reader, period: Period): Promise<ReportResultDto> {
  const info = await meta(db, period);
  const where = sql`o.created_at >= b.lo AND o.created_at < b.hi AND o.status <> 'cancelled'`;
  const result = await db.execute(sql`
    WITH ${bounds(period)}
    SELECT o.promo_code AS code, count(*)::text AS orders, sum(o.discount_total)::text AS discount,
           sum(o.total::bigint)::text AS total
      FROM orders o, bounds b WHERE ${where} AND o.promo_code IS NOT NULL
     GROUP BY 1 ORDER BY sum(o.discount_total) DESC, 1 LIMIT ${ROW_CAP + 1}`);
  const rows = result.rows.map((row) => promoRow.parse(row));
  const totals = await db.execute(sql`
    WITH ${bounds(period)}
    SELECT count(*) FILTER (WHERE o.promo_code IS NOT NULL)::text AS promo_orders,
           coalesce(sum(o.discount_total) FILTER (WHERE o.promo_code IS NOT NULL), 0)::text AS discount,
           coalesce(sum(o.total::bigint) FILTER (WHERE o.promo_code IS NOT NULL), 0)::text AS total,
           count(*)::text AS all_orders
      FROM orders o, bounds b WHERE ${where}`);
  const t = z
    .object({ promo_orders: str, discount: str, total: str, all_orders: str })
    .parse(totals.rows[0]);
  return {
    name: 'promos',
    ...info,
    table: {
      columns: [
        { key: 'code', kind: 'text' },
        { key: 'orders', kind: 'int' },
        { key: 'discount', kind: 'money' },
        { key: 'orderTotal', kind: 'money' },
      ],
      rows: rows
        .slice(0, ROW_CAP)
        .map((r) => [r.code, num(r.orders), moneyFromDb(r.discount), moneyFromDb(r.total)]),
      totals: ['', num(t.promo_orders), moneyFromDb(t.discount), moneyFromDb(t.total)],
      truncated: rows.length > ROW_CAP,
    },
    facts: [
      {
        key: 'ordersWithPromo',
        kind: 'bps',
        value: ratioBps(num(t.promo_orders), num(t.all_orders)),
      },
    ],
    chart: null,
    notes: ['ordersByCreation'],
  };
}

/* ─────────────────────────────── customers ─────────────────────────────── */

const segRow = z.object({ seg: str, customers: str, orders: str, gross: str });
const topLtvRow = z.object({ key: str, orders: str, ltv: str });
export const TOP_CUSTOMERS = 20;

/**
 * New versus returning by the FIRST capture of the customer (the mailbox, lower-cased, as the
 * customer list keys it): a customer whose first-ever capture is inside the period is new, one with
 * an earlier capture is returning. Top customers by lifetime net receipts (captured minus settled
 * refunds). The rows carry the customer KEY (the link to the card), never an email or a name.
 */
export async function readCustomersReport(db: Reader, period: Period): Promise<ReportResultDto> {
  const info = await meta(db, period);
  const ctes = sql`
    ${bounds(period)},
    cap AS (
      SELECT a.order_id, sum(a.captured_amount::bigint) AS gross, min(a.completed_at) AS at
        FROM payment_attempts a WHERE ${capturedRows} AND a.completed_at IS NOT NULL GROUP BY a.order_id),
    ref AS (
      SELECT r.order_id, sum(r.amount::bigint) AS amount
        FROM refund_operations r LEFT JOIN payment_attempts a ON a.id = r.payment_attempt_id
       WHERE ${settledRefundRows} GROUP BY r.order_id),
    per AS (
      SELECT lower(o.customer_email) AS email, c.at, c.gross, coalesce(f.amount, 0) AS refunded
        FROM cap c JOIN orders o ON o.id = c.order_id LEFT JOIN ref f ON f.order_id = c.order_id),
    first AS (SELECT email, min(at) AS first_at FROM per GROUP BY email)`;
  const segments = await db.execute(sql`
    WITH ${ctes}
    SELECT CASE WHEN f.first_at >= b.lo THEN 'new' ELSE 'returning' END AS seg,
           count(DISTINCT p.email)::text AS customers, count(*)::text AS orders,
           sum(p.gross)::text AS gross
      FROM per p JOIN first f ON f.email = p.email, bounds b
     WHERE p.at >= b.lo AND p.at < b.hi GROUP BY 1`);
  const top = await db.execute(sql`
    WITH ${ctes}
    SELECT left(encode(sha256(convert_to(email, 'UTF8')), 'hex'), 32) AS key, count(*)::text AS orders,
           (sum(gross) - sum(refunded))::text AS ltv
      FROM per GROUP BY email ORDER BY sum(gross) - sum(refunded) DESC, email LIMIT ${TOP_CUSTOMERS}`);
  const seg = new Map(segments.rows.map((row) => [segRow.parse(row).seg, segRow.parse(row)]));
  const rows: ReportCell[][] = (['new', 'returning'] as const).map((name) => {
    const row = seg.get(name);
    return [
      name,
      '',
      num(row?.customers ?? 0),
      num(row?.orders ?? 0),
      moneyFromDb(row?.gross ?? '0'),
    ];
  });
  for (const row of top.rows.map((r) => topLtvRow.parse(r))) {
    rows.push(['top', row.key, null, num(row.orders), moneyFromDb(row.ltv)]);
  }
  return {
    name: 'customers',
    ...info,
    table: {
      columns: [
        { key: 'kind', kind: 'text' },
        { key: 'customer', kind: 'text' },
        { key: 'customers', kind: 'int' },
        { key: 'orders', kind: 'int' },
        { key: 'amount', kind: 'money' },
      ],
      rows,
      totals: null,
      truncated: false,
    },
    facts: [],
    chart: null,
    notes: ['customersByCapture', 'topLifetime'],
  };
}

/* ─────────────────────────────── providers ─────────────────────────────── */

const provAttempts = z.object({ provider: str, attempts: str, ok: str, failed: str });
const provRefunds = z.object({ provider: str, n: str, amount: str });

export async function readProvidersReport(db: Reader, period: Period): Promise<ReportResultDto> {
  const info = await meta(db, period);
  const attempts = await db.execute(sql`
    WITH ${bounds(period)}
    SELECT a.provider::text AS provider, count(*)::text AS attempts,
           (count(*) FILTER (WHERE a.state = 'succeeded' AND a.captured_amount > 0))::text AS ok,
           (count(*) FILTER (WHERE a.state = 'failed'))::text AS failed
      FROM payment_attempts a, bounds b WHERE a.created_at >= b.lo AND a.created_at < b.hi GROUP BY 1`);
  const refunds = await db.execute(sql`
    WITH ${bounds(period)}
    SELECT a.provider::text AS provider, count(*)::text AS n, sum(r.amount::bigint)::text AS amount
      FROM refund_operations r JOIN payment_attempts a ON a.id = r.payment_attempt_id, bounds b
     WHERE r.state = 'succeeded' AND r.settled_at >= b.lo AND r.settled_at < b.hi GROUP BY 1`);
  const byProvider = new Map<
    string,
    { attempts: number; ok: number; failed: number; refunds: number; amount: string }
  >();
  const slot = (provider: string) => {
    const existing = byProvider.get(provider);
    if (existing !== undefined) return existing;
    const fresh = { attempts: 0, ok: 0, failed: 0, refunds: 0, amount: '0' };
    byProvider.set(provider, fresh);
    return fresh;
  };
  for (const row of attempts.rows.map((r) => provAttempts.parse(r))) {
    Object.assign(slot(row.provider), {
      attempts: num(row.attempts),
      ok: num(row.ok),
      failed: num(row.failed),
    });
  }
  for (const row of refunds.rows.map((r) => provRefunds.parse(r))) {
    Object.assign(slot(row.provider), { refunds: num(row.n), amount: row.amount });
  }
  const names = [...byProvider.keys()].sort();
  const sumNum = (pick: (v: ReturnType<typeof slot>) => number) =>
    names.reduce((acc, name) => acc + pick(slot(name)), 0);
  const ok = sumNum((v) => v.ok);
  const failed = sumNum((v) => v.failed);
  return {
    name: 'providers',
    ...info,
    table: {
      columns: [
        { key: 'provider', kind: 'text' },
        { key: 'attempts', kind: 'int' },
        { key: 'succeeded', kind: 'int' },
        { key: 'failed', kind: 'int' },
        { key: 'successRate', kind: 'bps' },
        { key: 'refunds', kind: 'int' },
        { key: 'refundAmount', kind: 'money' },
      ],
      rows: names.map((name) => {
        const v = slot(name);
        return [
          name,
          v.attempts,
          v.ok,
          v.failed,
          ratioBps(v.ok, v.ok + v.failed),
          v.refunds,
          moneyFromDb(v.amount),
        ];
      }),
      totals: [
        '',
        sumNum((v) => v.attempts),
        ok,
        failed,
        ratioBps(ok, ok + failed),
        sumNum((v) => v.refunds),
        moneyFromDb(String(names.reduce((acc, name) => acc + num(slot(name).amount), 0))),
      ],
      truncated: false,
    },
    facts: [],
    chart: null,
    notes: ['successRateSettled'],
  };
}

/* ───────────────────────── viewed but not bought ───────────────────────── */

const viewedRow = z.object({ key: str, sku: str, name: str, views: str });

/**
 * Products with product-page views in the period and no purchase in it: a list, not a ratio. A
 * "view" is one session on one day (`product_views` keeps one row per product, session hash and
 * day, the day in UTC). Orders count by creation day, cancelled ones do not count as a purchase.
 */
export async function readViewedNotBought(db: Reader, period: Period): Promise<ReportResultDto> {
  const info = await meta(db, period);
  const result = await db.execute(sql`
    WITH ${bounds(period)}
    SELECT p.id::text AS key, p.sku, p.name_uk AS name, count(*)::text AS views
      FROM product_views v JOIN products p ON p.id = v.product_id, bounds b
     WHERE v.viewed_on >= ${period.from}::date AND v.viewed_on <= ${period.to}::date
       AND NOT EXISTS (
         SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE oi.product_uid_snapshot = p.id AND o.status <> 'cancelled'
            AND o.created_at >= b.lo AND o.created_at < b.hi)
     GROUP BY p.id ORDER BY count(*) DESC, p.sku LIMIT ${ROW_CAP + 1}`);
  const rows = result.rows.map((row) => viewedRow.parse(row));
  return {
    name: 'viewed-not-bought',
    ...info,
    table: {
      columns: [
        { key: 'product', kind: 'text' },
        { key: 'sku', kind: 'text' },
        { key: 'name', kind: 'text' },
        { key: 'views', kind: 'int' },
      ],
      rows: rows.slice(0, ROW_CAP).map((r) => [r.key, r.sku, r.name, num(r.views)]),
      totals: null,
      truncated: rows.length > ROW_CAP,
    },
    facts: [],
    chart: null,
    notes: ['viewsAreSessionDays', 'noConversion'],
  };
}
