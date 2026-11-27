/**
 * The dashboard and its alerts on real Postgres: each alert counts exactly its rows and carries no
 * row data; the margin KPI exists only inside the cost shape; the percentage follows the
 * divide-by-zero rule.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  orders,
  outbox,
  paymentAttempts,
  shipmentOperations,
  stockReservations,
} from '@store/db/schema';
import { COST_FIELD_NAMES, alertCodes } from '@store/shared/dto/reports';

import { readAlerts } from '../src/reports/alerts.ts';
import { readDashboard } from '../src/reports/dashboard.ts';
import { parsePeriod } from '../src/reports/period.ts';
import { createWorld, type TestWorld } from './fixtures.ts';
import { insertOrder } from './reports-fixture.ts';

let world: TestWorld;
let empty: TestWorld;
const period = parsePeriod({ from: '2026-08-01', to: '2026-08-31' });

beforeAll(async () => {
  empty = await createWorld();
  world = await createWorld();
  const { db } = world.connect(2);
  await db.transaction(async (tx) => {
    const base = await insertOrder(tx, {
      lines: [{ quantity: 1, price: 30_000, cost: 10_000 }],
      captures: [{ at: '2026-08-10T10:00:00Z', amount: 30_000 }],
      refunds: [
        { at: null, amount: 1_000, state: 'unknown' },
        { at: null, amount: 1_000, state: 'pending' },
      ],
    });
    await insertOrder(tx, {
      lines: [{ quantity: 1, price: 10_000, cost: 4_000 }],
      captures: [{ at: '2026-07-10T10:00:00Z', amount: 10_000 }],
    });
    // Old unpublished outbox rows count; a fresh one and a published one do not.
    await tx.insert(outbox).values([
      { topic: 't', payload: {}, createdAt: new Date(Date.now() - 3_600_000) },
      { topic: 't', payload: {}, createdAt: new Date() },
      {
        topic: 't',
        payload: {},
        createdAt: new Date(Date.now() - 3_600_000),
        publishedAt: new Date(),
      },
    ]);
    await tx.insert(paymentAttempts).values({
      orderId: base.orderId,
      attemptNumber: 9,
      provider: 'mono',
      state: 'unknown',
      status: 'pending',
      amount: 500,
    });
    await tx
      .update(orders)
      .set({ fiscalStatus: 'failed' })
      .where(sql`id = ${base.orderId}`);
    await tx.insert(shipmentOperations).values({
      orderId: base.orderId,
      carrier: 'np',
      state: 'unknown',
    });
    await tx.insert(stockReservations).values([
      {
        variantId: world.fixture.variantIds[0],
        orderId: base.orderId,
        quantity: 1,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
      {
        variantId: world.fixture.variantIds[1],
        orderId: base.orderId,
        quantity: 1,
        expiresAt: new Date(Date.now() + 3 * 3_600_000),
      },
    ]);
  });
});
afterAll(async () => {
  await world.close();
  await empty.close();
});

describe('alerts', () => {
  it('count exactly their rows, in a fixed order, and carry only a count and an age', async () => {
    const alerts = await readAlerts(world.connect(1).db);
    expect(alerts.map((a) => a.code)).toEqual([...alertCodes]);
    const count = Object.fromEntries(alerts.map((a) => [a.code, a.count]));
    expect(count).toEqual({
      outbox_stuck: 1,
      refund_open: 0, // the refund rows are brand new: the 10 minute grace period applies
      payment_unknown: 1,
      reservation_expiring: 1,
      low_stock: 2,
      fiscal_failed: 1,
      waybill_unknown: 1,
    });
    expect(alerts.find((a) => a.code === 'outbox_stuck')?.oldestAt).toMatch(/Z$/);
    expect(Object.keys(alerts[0] ?? {}).sort()).toEqual(['code', 'count', 'oldestAt']);
  });

  it('an old unknown refund is an alert; a young one is not', async () => {
    const { db } = world.connect(1);
    await db.execute(
      sql`UPDATE refund_operations SET created_at = now() - interval '20 minutes' WHERE state = 'unknown'`,
    );
    const alerts = await readAlerts(db);
    expect(alerts.find((a) => a.code === 'refund_open')?.count).toBe(1);
  });

  it('an empty database has seven zero alerts', async () => {
    const { db } = empty.connect(1);
    await db.execute(sql`DELETE FROM product_variants`);
    const alerts = await readAlerts(db);
    expect(alerts.every((a) => a.count === 0 && a.oldestAt === null)).toBe(true);
  });
});

describe('dashboard', () => {
  it('KPIs against the previous period; the margin KPI only inside the cost shape', async () => {
    const { db } = world.connect(1);
    const owner = await readDashboard(db, period, { includeCost: true });
    const manager = await readDashboard(db, period, { includeCost: false });
    expect(owner.kpis.map((k) => k.key)).toEqual(['gross', 'refunds', 'net', 'captures', 'margin']);
    expect(manager.kpis.map((k) => k.key)).toEqual(['gross', 'refunds', 'net', 'captures']);
    const gross = manager.kpis.find((k) => k.key === 'gross');
    expect(gross).toMatchObject({
      current: 30_000,
      vsPrevious: { previous: 10_000, absolute: 20_000, percentBps: 20_000 },
    });
    expect(owner.kpis.find((k) => k.key === 'margin')?.current).toBe(20_000);
    const text = JSON.stringify(manager);
    for (const name of COST_FIELD_NAMES) expect(text, name).not.toContain(`"${name}"`);
    expect(text).not.toMatch(/margin/i);
  });

  it('an empty shop: zeros, no percentage, no last-year column', async () => {
    const { db } = empty.connect(1);
    const dashboard = await readDashboard(db, period, { includeCost: true });
    expect(dashboard.lastYear).toBeNull();
    for (const kpi of dashboard.kpis) {
      expect(kpi.current).toBe(0);
      expect(kpi.vsPrevious.percentBps).toBeNull();
      expect(kpi.vsLastYear).toBeNull();
    }
  });
});
