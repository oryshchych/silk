/**
 * Performance of the reports on 50 000 synthetic orders (real Postgres, the app role, a read-only
 * transaction with a statement timeout, exactly how the admin runs them). The target is under one
 * second per report; the assertion is the CI bound (three times that: a shared runner is slower
 * than a laptop) and the REAL numbers are printed so the phase report can quote them.
 *
 * Also pins the shape of the data the figures are judged on: the synthetic mix is deterministic,
 * so the totals below are exact and a change to the dataset or to a figure shows up here.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, subtract, sum, ZERO } from '@store/shared/money';
import { createDb, type DbHandle } from '@store/db/client';
import { seedSynthetic, SYNTHETIC_DEFAULT_ORDERS } from '@store/db/seed/synthetic';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import type { Reader } from '@store/db/types';

import { runReport, parseReportRequest } from '../src/reports/run.ts';
import { readRevenueComparison } from '../src/reports/comparison.ts';
import { readMargin, readMarginBreakdown } from '../src/reports/margin.ts';
import { parsePeriod, type Period } from '../src/reports/period.ts';
import { readRevenue } from '../src/reports/revenue.ts';

/** One second is the target; the bound CI enforces is generous on purpose. */
export const TARGET_MS = 1_000;
export const CI_BOUND_MS = 3_000;

let testDb: TestDatabase;
let handle: DbHandle;
const timings: { name: string; coldMs: number; warmMs: number }[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2, statementTimeoutMs: 25_000 });
  await handle.db.transaction(async (tx) => {
    await seedSynthetic(tx, { orders: SYNTHETIC_DEFAULT_ORDERS });
  });
  // 200 products (the ids the synthetic lines point at), 150 000 views and 400 variants for the
  // product-based reports.
  await handle.db.execute(sql`INSERT INTO categories (slug, name_uk, name_en, size_system)
    VALUES ('syn', 'Syn', 'Syn', 'apparel')`);
  await handle.db
    .execute(sql`INSERT INTO products (id, sku, slug, brand, category_id, name_uk, name_en, base_price, cost_price, is_active)
    SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'SYN-' || g, 'syn-' || g, 'Syn',
           (SELECT id FROM categories LIMIT 1), 'Product ' || g, 'Product ' || g, 50000, 20000, true
      FROM generate_series(0, 199) g`);
  await handle.db.execute(
    sql`INSERT INTO sizes (system, label, sort_order) VALUES ('apparel', 'M', 1)`,
  );
  await handle.db.execute(
    sql`INSERT INTO colors (slug, name_uk, name_en, hex) VALUES ('syn', 'Syn', 'Syn', '#000000')`,
  );
  await handle.db
    .execute(sql`INSERT INTO product_variants (product_id, size_id, color_id, sku, stock_quantity)
    SELECT p.id, (SELECT id FROM sizes LIMIT 1), (SELECT id FROM colors LIMIT 1), 'V-' || p.sku, (length(p.sku) * 3) % 9
      FROM products p`);
  await handle.db.execute(sql`INSERT INTO product_views (product_id, session_hash, viewed_on)
    SELECT ('00000000-0000-4000-8000-' || lpad((g % 200)::text, 12, '0'))::uuid, md5(g::text),
           date '2026-01-01' + (g % 300)
      FROM generate_series(1, 150000) g ON CONFLICT DO NOTHING`);
  await handle.db.execute(sql`ANALYZE`);
}, 300_000);
afterAll(async () => {
  const lines = timings.map(
    (t) =>
      `  ${t.name.padEnd(34)} cold ${String(t.coldMs).padStart(5)} ms   warm ${String(t.warmMs).padStart(5)} ms`,
  );
  process.stdout.write(
    `\nreport timings on ${String(SYNTHETIC_DEFAULT_ORDERS)} orders:\n${lines.join('\n')}\n`,
  );
  await handle.close();
  await testDb.drop();
});

/** The way the admin runs a report: one read-only transaction with its own statement timeout. */
async function asAdmin<T>(run: (tx: Reader) => Promise<T>): Promise<T> {
  return await handle.db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = 25000`);
      return await run(tx);
    },
    { accessMode: 'read only' },
  );
}

async function measure<T>(name: string, run: (tx: Reader) => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const value = await asAdmin(run);
  const coldMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  await asAdmin(run);
  const warmMs = Math.round(performance.now() - t1);
  timings.push({ name, coldMs, warmMs });
  expect(coldMs, `${name} cold`).toBeLessThan(CI_BOUND_MS);
  expect(warmMs, `${name} warm`).toBeLessThan(CI_BOUND_MS);
  return value;
}

const whole: Period = parsePeriod({ from: '2025-01-01', to: '2026-12-31', granularity: 'month' });
const week: Period = parsePeriod({ from: '2025-01-01', to: '2025-12-31', granularity: 'week' });
const day: Period = parsePeriod({ from: '2026-01-01', to: '2026-12-31', granularity: 'day' });

describe('reports on 50 000 orders', () => {
  it('the dataset is what the seed says it is', async () => {
    const result = await handle.db.execute<{
      orders: string;
      attempts: string;
      refunds: string;
    }>(sql`
      SELECT (SELECT count(*) FROM orders)::text AS orders,
             (SELECT count(*) FROM payment_attempts)::text AS attempts,
             (SELECT count(*) FROM refund_operations)::text AS refunds`);
    expect(Number(result.rows[0]?.orders)).toBe(50_000);
    expect(Number(result.rows[0]?.attempts)).toBeGreaterThan(30_000);
    expect(Number(result.rows[0]?.refunds)).toBeGreaterThan(3_000);
  });

  it('the synthetic seed refuses a database that already holds orders', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await seedSynthetic(tx, { orders: 10 });
      }),
    ).rejects.toThrow(/already holds/);
  });

  it('revenue by month, week and day', async () => {
    const monthly = await measure('revenue (month, 23 months)', (tx) => readRevenue(tx, whole));
    await measure('revenue (week, 1 year)', (tx) => readRevenue(tx, week));
    await measure('revenue (day, 1 year)', (tx) => readRevenue(tx, day));
    // The series always adds up to the totals, at scale too.
    expect(sum(monthly.series.map((p) => p.gross))).toBe(monthly.totals.gross);
    expect(sum(monthly.series.map((p) => p.refunds))).toBe(monthly.totals.refunds);
    expect(monthly.totals.gross).toBeGreaterThan(0);
    expect(monthly.totals.net).toBe(subtract(monthly.totals.gross, monthly.totals.refunds));
    expect(monthly.totals.untimedCaptures).toBe(0);
    // Every paid order was captured once through the journal, none through COD.
    const orderLevel = await handle.db.execute<{ captured: string; refunded: string }>(sql`
      SELECT sum(captured_total)::text AS captured, sum(refunded_total)::text AS refunded FROM orders`);
    expect(String(monthly.totals.gross)).toBe(
      (
        await handle.db.execute<{ v: string }>(
          sql`SELECT sum(captured_total)::text AS v FROM orders WHERE payment_provider <> 'cod'`,
        )
      ).rows[0]?.v,
    );
    expect(Number(orderLevel.rows[0]?.refunded)).toBe(monthly.totals.refunds);
  });

  it('margin totals and both breakdowns', async () => {
    const margin = await measure('margin totals', (tx) => readMargin(tx, whole));
    const products = await measure('margin by product', (tx) =>
      readMarginBreakdown(tx, whole, { by: 'product', limit: 200 }),
    );
    const categories = await measure('margin by category', (tx) =>
      readMarginBreakdown(tx, whole, { by: 'category' }),
    );
    const goods = subtract(margin.totals.goodsRevenue, margin.totals.costOfGoods);
    expect(add(sum(products.rows.map((r) => r.margin)), products.rest?.margin ?? ZERO)).toBe(goods);
    expect(sum(categories.rows.map((r) => r.margin))).toBe(goods);
    expect(margin.totals.noCostLines).toBeGreaterThan(0);
  });

  it('every other report through the registry (owner, the heaviest shape)', async () => {
    const window = { from: '2025-06-01', to: '2026-05-31' };
    for (const name of [
      'orders',
      'top-products',
      'returns',
      'promos',
      'customers',
      'providers',
      'viewed-not-bought',
    ] as const) {
      const request = parseReportRequest(name, window);
      const result = await measure(`${name} (1 year)`, (tx) => runReport(tx, request, 'owner'));
      if (name !== 'viewed-not-bought') expect(result.table.rows.length, name).toBeGreaterThan(0);
    }
    const stock = await measure('stock', (tx) =>
      runReport(tx, parseReportRequest('stock', { threshold: 5 }), 'owner'),
    );
    expect(stock.table.rows.length).toBeGreaterThan(0);
    await measure('margin by product (registry)', (tx) =>
      runReport(tx, parseReportRequest('margin', { ...window, by: 'product' }), 'owner'),
    );
  });

  it('the dashboard comparison (three periods)', async () => {
    await measure('comparison (3 revenue reads)', (tx) =>
      readRevenueComparison(
        tx,
        parsePeriod({ from: '2026-10-01', to: '2026-10-31', granularity: 'day' }),
      ),
    );
  });
});
