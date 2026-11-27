/**
 * The ten reports through the registry on real Postgres: what each one counts, the role matrix on
 * the SERIALISED result (JSON), and the CSV equal to the screen to the kopiyka.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminRole } from '@store/core/auth-permissions';
import {
  COST_FIELD_NAMES,
  reportNames,
  type ReportName,
  type ReportResultDto,
} from '@store/shared/dto/reports';
import { productViews, products } from '@store/db/schema';
import { parseHryvnias } from '@store/shared/money';

import { parseCsv, unsafeCell } from '../src/catalog-admin/csv.ts';
import { resultToCsv } from '../src/reports/csv.ts';
import {
  ReportForbiddenError,
  mayRunReport,
  parseReportRequest,
  runReport,
  runReportOn,
} from '../src/reports/run.ts';
import { createWorld, type TestWorld } from './fixtures.ts';
import { insertOrder } from './reports-fixture.ts';

let world: TestWorld;
let productId: string;
const range = { from: '2026-06-01', to: '2026-06-30' };

const run = async (name: ReportName, role: AdminRole, extra: Record<string, unknown> = {}) => {
  const handle = world.connect(1);
  return await runReportOn(handle.db, parseReportRequest(name, { ...range, ...extra }), role);
};

beforeAll(async () => {
  world = await createWorld();
  productId = world.fixture.productId;
  const handle = world.connect(2);
  await handle.db.update(products).set({ costPrice: 40_000 });
  await handle.db.transaction(async (tx) => {
    await insertOrder(tx, {
      createdAt: '2026-06-10T10:00:00Z',
      email: 'Anna@Example.com',
      promoCode: 'SPRING',
      lines: [
        {
          uid: productId,
          name: '=HYPERLINK("http://x")',
          quantity: 2,
          price: 100_000,
          discount: 20_000,
          cost: 40_000,
        },
      ],
      captures: [{ at: '2026-06-10T10:05:00Z', amount: 180_000 }],
      refunds: [{ at: '2026-06-12T10:00:00Z', amount: 30_000 }],
    });
    await insertOrder(tx, {
      createdAt: '2026-06-15T10:00:00Z',
      email: 'anna@example.com',
      lines: [{ uid: productId, quantity: 1, price: 50_000, cost: 20_000 }],
      captures: [{ at: '2026-06-15T10:05:00Z', amount: 50_000, provider: 'wayforpay' }],
      returns: [
        {
          receivedAt: '2026-06-20T10:00:00Z',
          reason: 'defect',
          items: [{ line: 0, received: 1, restocked: 0 }],
        },
      ],
    });
    await insertOrder(tx, {
      createdAt: '2026-06-16T10:00:00Z',
      provider: 'cod',
      email: 'bob@example.com',
      lines: [{ uid: productId, quantity: 1, price: 70_000, cost: 30_000 }],
    });
    await insertOrder(tx, {
      createdAt: '2026-06-17T10:00:00Z',
      status: 'cancelled',
      cancelledAt: '2026-06-17T12:00:00Z',
      lines: [{ quantity: 1, price: 9_000, cost: 1_000 }],
    });
    await insertOrder(tx, {
      createdAt: '2026-07-10T10:00:00Z',
      lines: [{ name: '=HYPERLINK("http://x")', quantity: 1, price: 1_000, cost: null }],
    });
    await tx.insert(productViews).values([
      { productId, sessionHash: 'a'.repeat(64), viewedOn: '2026-07-05' },
      { productId, sessionHash: 'b'.repeat(64), viewedOn: '2026-07-05' },
    ]);
  });
});
afterAll(async () => {
  await world.close();
});

describe('what each report counts', () => {
  it('orders: by status, delivery and payment; all orders created in the period', async () => {
    const r = await run('orders', 'owner');
    expect(r.table.totals).toEqual(['all', '', 4, 309_000]);
    const status = r.table.rows.filter((row) => row[0] === 'status');
    expect(status.map((row) => [row[1], row[2]])).toEqual(
      [
        ['cancelled', 1],
        ['confirmed', 3],
        ['delivered', 0],
      ].filter((x) => x[1] !== 0),
    );
  });

  it('top products: units and revenue of lines of orders that are not cancelled', async () => {
    const r = await run('top-products', 'manager');
    expect(r.table.rows[0]?.slice(2)).toEqual([4, 180_000 + 50_000 + 70_000]);
    expect(r.table.totals?.slice(2)).toEqual([4, 300_000]);
  });

  it('promos: the discount of the code and its share of orders', async () => {
    const r = await run('promos', 'admin');
    expect(r.table.rows).toEqual([['SPRING', 1, 20_000, 180_000]]);
    expect(r.facts.find((f) => f.key === 'ordersWithPromo')?.value).toBe(3333);
  });

  it('returns: by reason, with the rate per paid order and no label called conversion', async () => {
    const r = await run('returns', 'owner');
    expect(r.table.rows).toEqual([['defect', 1, 1, 0, 0]]);
    expect(r.facts.find((f) => f.key === 'paidOrders')?.value).toBe(2);
    expect(r.facts.find((f) => f.key === 'returnRate')?.value).toBe(5000);
    expect(JSON.stringify(r)).not.toMatch(/conversion/i);
  });

  it('customers: new and returning by first capture, the key never an email', async () => {
    const r = await run('customers', 'owner');
    expect(r.table.rows.slice(0, 2)).toEqual([
      ['new', '', 1, 2, 230_000],
      ['returning', '', 0, 0, 0],
    ]);
    const top = r.table.rows.filter((row) => row[0] === 'top');
    expect(top).toHaveLength(1);
    expect(top[0]?.[4]).toBe(230_000 - 30_000);
    expect(JSON.stringify(r)).not.toMatch(/example\.com|@/);
  });

  it('providers: attempts, settled success rate, refunds by provider', async () => {
    const r = await run('providers', 'owner');
    const byName = Object.fromEntries(r.table.rows.map((row) => [String(row[0]), row]));
    expect(byName['mono']).toEqual(['mono', 1, 1, 0, 10_000, 1, 30_000]);
    expect(byName['wayforpay']?.slice(0, 5)).toEqual(['wayforpay', 1, 1, 0, 10_000]);
  });

  it('viewed but not bought: products with views and no purchase in the period', async () => {
    const quiet = await run('viewed-not-bought', 'owner', { from: '2026-07-01', to: '2026-07-31' });
    expect(quiet.table.rows).toHaveLength(1);
    expect(quiet.table.rows[0]?.[3]).toBe(2);
    const bought = await run('viewed-not-bought', 'owner');
    expect(bought.table.rows).toHaveLength(0);
  });

  it('stock: low stock list, the value at price for everyone, at cost only for the cost role', async () => {
    const owner = await run('stock', 'owner', { threshold: 5 });
    const manager = await run('stock', 'manager', { threshold: 5 });
    expect(owner.table.columns.map((c) => c.key)).toContain('cost');
    expect(manager.table.columns.map((c) => c.key)).not.toContain('cost');
    expect(owner.facts.map((f) => f.key)).toContain('stockValueAtCost');
    expect(manager.facts.map((f) => f.key)).not.toContain('stockValueAtCost');
    expect(owner.table.rows).toHaveLength(2);
    expect(manager.table.rows[0]).toHaveLength(manager.table.columns.length);
    expect(owner.facts.find((f) => f.key === 'stockValueAtCost')?.value).toBe(80_000);
  });

  it('margin: the cost role only, by product and by category', async () => {
    const r = await run('margin', 'owner');
    // sold: 180 000 - 80 000 and 50 000 - 20 000; return received: -50 000 revenue, no restock so cost stays
    expect(r.table.totals?.slice(3, 5)).toEqual([180_000 + 50_000 - 50_000, 80_000 + 20_000]);
    const cat = await run('margin', 'admin', { by: 'category' });
    expect(cat.table.rows[0]?.[0]).toBe('Bras');
  });
});

describe('the role matrix on the serialised result', () => {
  const roles: AdminRole[] = ['owner', 'admin', 'manager', 'content'];

  it('the matrix: reports.view for owner, admin, manager; margin for the cost roles only', () => {
    for (const name of reportNames) {
      expect(mayRunReport('content', name)).toBe(false);
      expect(mayRunReport('manager', name)).toBe(name !== 'margin');
      expect(mayRunReport('admin', name)).toBe(true);
      expect(mayRunReport('owner', name)).toBe(true);
    }
  });

  it('a refused role gets the error BEFORE any query (a pool that is never used)', async () => {
    const never = {
      transaction: () => {
        throw new Error('a connection was taken');
      },
    };
    await expect(
      runReport(never, parseReportRequest('margin', range), 'manager'),
    ).rejects.toBeInstanceOf(ReportForbiddenError);
    await expect(
      runReport(never, parseReportRequest('revenue', range), 'content'),
    ).rejects.toBeInstanceOf(ReportForbiddenError);
  });

  it('the public runReport runs read only: it answers on a real pool and cannot write', async () => {
    const handle = world.connect(1);
    const result = await runReport(handle.db, parseReportRequest('orders', range), 'owner');
    expect(result.name).toBe('orders');
    expect(result.asOf).toMatch(/Z$/);
  });

  it('no cost field name appears in any JSON a role without the cost permission can get', async () => {
    for (const role of ['manager'] as const) {
      for (const name of reportNames) {
        if (!mayRunReport(role, name)) continue;
        const result = await run(name, role);
        const text = JSON.stringify(result);
        const keys = new Set<string>();
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) node.forEach(walk);
          else if (node !== null && typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) {
              keys.add(k);
              if (k === 'key' && typeof v === 'string') keys.add(v);
              walk(v);
            }
          }
        };
        walk(JSON.parse(text));
        for (const forbidden of COST_FIELD_NAMES) {
          expect(keys.has(forbidden), `${name} for ${role} exposes ${forbidden}`).toBe(false);
        }
        expect(resultToCsv(result).toLowerCase()).not.toMatch(/cost|margin/);
      }
    }
    expect(roles).toHaveLength(4);
  });
});

describe('the export equals the screen', () => {
  const parseBack = (result: ReportResultDto) => {
    const parsed = parseCsv(resultToCsv(result));
    const rows = parsed.rows.map((r) => r.cells.map(unsafeCell));
    return { header: parsed.header, rows };
  };

  it('every report: the same cells to the kopiyka, in the same order, totals included', async () => {
    for (const name of reportNames) {
      const result = await run(name, 'owner');
      const { header, rows } = parseBack(result);
      expect(header).toEqual(
        result.table.columns.map((c) =>
          (c.kind === 'bps' ? `${c.key}_percent` : c.key).toLowerCase(),
        ),
      );
      const expected = [
        ...result.table.rows,
        ...(result.table.totals === null ? [] : [result.table.totals]),
      ];
      const data = rows.filter((r) => r[0] !== '#fact' && !(r[0] ?? '').startsWith('# truncated'));
      expect(data.length, name).toBe(expected.length);
      for (const [rowIndex, cells] of data.entries()) {
        const row = expected[rowIndex] ?? [];
        for (const [i, column] of result.table.columns.entries()) {
          const screen = row[i] ?? null;
          const file = cells[i] ?? '';
          const isTotals = result.table.totals !== null && rowIndex === expected.length - 1;
          if (screen === null) expect(file).toBe('');
          else if (column.kind === 'money') expect(parseHryvnias(file)).toBe(screen);
          else if (column.kind === 'bps') expect(Math.round(Number(file) * 100)).toBe(screen);
          else if (isTotals && i === 0 && screen === '') expect(file).toBe('TOTAL');
          else expect(file).toBe(String(screen));
        }
      }
    }
  });

  it('a product name that starts like a formula is text in the file', async () => {
    const result = await run('top-products', 'owner', { from: '2026-07-01', to: '2026-07-31' });
    const text = resultToCsv(result);
    expect(text).toContain(`'=HYPERLINK`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('a result cut at its cap says so in the last line', () => {
    const cut: ReportResultDto = {
      name: 'orders',
      asOf: 'x',
      period: null,
      facts: [],
      chart: null,
      notes: [],
      table: {
        columns: [{ key: 'a', kind: 'text' }],
        rows: [['1']],
        totals: null,
        truncated: true,
      },
    };
    expect(resultToCsv(cut).trim().split('\r\n').at(-1)).toMatch(/^# truncated/);
  });
});

describe('bad input is a typed refusal, never a query', () => {
  it.each([
    [{ from: '2026-02-30', to: '2026-03-01' }],
    [{ from: '2026-06-01', to: '2026-06-30', sort: 'drop table' }],
    [{ from: '2026-06-01', to: '2026-06-30', extra: '1' }],
    [{ from: '2026-06-01', to: '2026-06-30', threshold: '99999' }],
  ])('%j', (raw) => {
    expect(() => parseReportRequest('revenue', raw)).toThrow();
  });
  it('the SQL of a report cannot be steered by a parameter', async () => {
    const handle = world.connect(1);
    const result = await runReportOn(
      handle.db,
      parseReportRequest('top-products', { ...range, sort: 'revenue' }),
      'owner',
    );
    expect(result.table.rows.length).toBeGreaterThan(0);
    await handle.db.execute(sql`SELECT 1`);
  });
});
