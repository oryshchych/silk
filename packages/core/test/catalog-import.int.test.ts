/**
 * CSV import and export on real Postgres: preview writes nothing, a commit applies the good rows
 * and names the bad ones by line, update-by-SKU leaves empty cells alone, a role without a right
 * gets an error instead of a silent drop, and the export carries the cost only for a role that may
 * see it.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { categories, products } from '@store/db/schema';

import { parseCsv } from '../src/catalog-admin/csv.ts';
import { exportParts, exportProductsCsv } from '../src/catalog-admin/export.ts';
import { applyImport, planImport } from '../src/catalog-admin/import.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let handle: DbHandle;
let categorySlug: string;

const ALL = { canPrice: true, canSeeCost: true } as const;

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(4);
  const [row] = await handle.db.select({ slug: categories.slug }).from(categories).limit(1);
  categorySlug = row?.slug ?? '';
});
afterAll(async () => {
  await world.close();
});

const header =
  'sku,slug,brand,category,name_uk,name_en,price,compare_at_price,cost_price,weight_grams';
const line = (n: number, extra: Partial<Record<string, string>> = {}): string =>
  [
    extra['sku'] ?? `IMP-${String(n)}`,
    extra['slug'] ?? `imp-${String(n)}`,
    extra['brand'] ?? 'Brand',
    extra['category'] ?? categorySlug,
    extra['nameUk'] ?? `Товар ${String(n)}`,
    extra['nameEn'] ?? `Product ${String(n)}`,
    extra['price'] ?? '499.00',
    extra['compare'] ?? '',
    extra['cost'] ?? '200.00',
    extra['weight'] ?? '150',
  ].join(',');

const importCsv = async (text: string, caps = ALL) => {
  const plan = await planImport(handle.db, parseCsv(text), caps);
  const outcome = await handle.db.transaction(async (tx) => await applyImport(tx, plan, 'batch-1'));
  return { plan, outcome };
};
const productBySku = async (sku: string) =>
  (await handle.db.select().from(products).where(eq(products.sku, sku)))[0];

describe('import: preview and commit', () => {
  it('100 rows with 3 broken: the preview writes nothing and names the 3 lines; the commit imports 97', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => line(i + 1));
    rows[9] = line(10, { price: 'abc' }); // file line 11
    rows[49] = line(50, { category: 'no-such-category' }); // line 51
    rows[89] = line(90, { sku: '' }); // line 91
    const text = [header, ...rows].join('\n');
    const plan = await planImport(handle.db, parseCsv(text), ALL);
    const bad = plan.results.filter((r) => r.action === 'error');
    expect(bad.map((r) => [r.line, r.errors[0]])).toEqual([
      [11, 'price_invalid'],
      [51, 'category_unknown'],
      [91, 'sku_required'],
    ]);
    expect(await productBySku('IMP-1')).toBeUndefined();

    const { outcome } = await importCsv(text);
    expect(outcome.data).toMatchObject({ created: 97, updated: 0, failed: 3 });
    expect(await productBySku('IMP-1')).toMatchObject({
      isActive: false,
      basePrice: 49_900,
      costPrice: 20_000,
    });
    expect(await productBySku('IMP-10')).toBeUndefined();
    // One audit row per written product plus the summary; none carries the cost.
    expect(outcome.extraAudits?.length).toBe(97);
    expect(JSON.stringify(outcome)).not.toContain('20000');
  }, 60_000);

  it('update by SKU: an empty cell leaves the field, a filled one changes it, nothing else moves', async () => {
    await importCsv([header, line(500)].join('\n'));
    const before = await productBySku('IMP-500');
    const { outcome } = await importCsv(
      ['sku,name_en,price', 'IMP-500,Renamed,'].join('\n') + '\nIMP-500-NEW,,\n',
    );
    // The second row is a create without names: an error; the first is an update of the name only.
    expect(outcome.data.results.map((r) => [r.action, r.errors.length > 0])).toEqual([
      ['update', false],
      ['error', true],
    ]);
    const after = await productBySku('IMP-500');
    expect(after?.nameEn).toBe('Renamed');
    expect(after?.basePrice).toBe(before?.basePrice);
    expect(after?.brand).toBe(before?.brand);
    expect(after?.costPrice).toBe(before?.costPrice);
  });

  it('a duplicate SKU in the file, an unknown column, a short row and a taken slug are reported, the rest still import', async () => {
    await importCsv([header, line(600)].join('\n'));
    const text = [
      `${header},colour`,
      `${line(601)},red`,
      `${line(601)},red`,
      'IMP-602',
      `${line(603, { slug: 'imp-600' })},red`,
      `${line(604)},red`,
    ].join('\n');
    const { plan, outcome } = await importCsv(text);
    expect(plan.ignoredColumns).toEqual(['colour']);
    const byLine = new Map(outcome.data.results.map((r) => [r.line, r]));
    expect(byLine.get(3)?.errors).toContain('sku_duplicate_in_file');
    expect(byLine.get(4)?.errors).toContain('row_too_short');
    // Reported by the PREVIEW now, not first at the commit.
    expect(byLine.get(5)?.errors).toEqual(['slug_taken']);
    expect(byLine.get(2)?.action).toBe('create');
    expect(byLine.get(6)?.action).toBe('create');
    expect(await productBySku('IMP-601')).toBeDefined();
    expect(await productBySku('IMP-604')).toBeDefined();
    expect(await productBySku('IMP-603')).toBeUndefined();
  });

  it('a role without the right gets an ERROR on that row, not a silent drop: no price right, no cost right', async () => {
    const withCost = [header, line(700)].join('\n');
    const noPrice = await planImport(handle.db, parseCsv(withCost), {
      canPrice: false,
      canSeeCost: false,
    });
    expect(noPrice.results[0]?.errors).toEqual(
      expect.arrayContaining(['price_forbidden', 'cost_forbidden']),
    );
    const noCost = await planImport(handle.db, parseCsv(withCost), {
      canPrice: true,
      canSeeCost: false,
    });
    expect(noCost.results[0]?.errors).toEqual(['cost_forbidden']);
    expect(await productBySku('IMP-700')).toBeUndefined();
  });

  it('hostile text is stored as text and a price over the old price rule is refused for that row only', async () => {
    const text = [
      header,
      line(800, {
        nameEn: '=HYPERLINK("http://evil.example")',
        nameUk: '<script>alert(1)</script>',
      }),
      line(801, { price: '100.00', compare: '90.00' }),
    ].join('\n');
    const { outcome } = await importCsv(text);
    expect((await productBySku('IMP-800'))?.nameEn).toBe('=HYPERLINK("http://evil.example")');
    expect(outcome.data.results.find((r) => r.sku === 'IMP-801')?.action).toBe('error');
  });
});

describe('review round 1', () => {
  it('a row that fails in its SECOND step leaves nothing behind (the savepoint): no half-written product, no audit row for it', async () => {
    // price 50 with an old price of 40: createProduct succeeds, the pricing step then throws.
    const text = [header, line(1000, { price: '50.00', compare: '40.00' }), line(1001)].join('\n');
    const { outcome } = await importCsv(text);
    expect(outcome.data.results.find((r) => r.sku === 'IMP-1000')?.errors).toEqual([
      'ADMIN_INVALID_PRICE',
    ]);
    expect(await productBySku('IMP-1000')).toBeUndefined();
    expect(await productBySku('IMP-1001')).toBeDefined();
    const entityIds = (outcome.extraAudits ?? []).map((a) => a.entityId);
    const half = await handle.db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.sku, 'IMP-1000'));
    expect(half).toHaveLength(0);
    expect(entityIds).toHaveLength(1);
  });

  it('re-importing an exported file does not corrupt cells that were neutralised for the spreadsheet', async () => {
    await importCsv(
      [header, line(1100, { brand: '-Brand', nameEn: '=Name', nameUk: '@Імя' })].join('\n'),
    );
    const exported = await exportProductsCsv(handle.db, { canSeeCost: true });
    await importCsv(exported.csv);
    const row = await productBySku('IMP-1100');
    expect([row?.brand, row?.nameEn, row?.nameUk]).toEqual(['-Brand', '=Name', '@Імя']);
  });

  it('export: `after` continues behind a SKU, and a small catalogue needs no parts', async () => {
    const all = await exportProductsCsv(handle.db, { canSeeCost: false });
    const skus = parseCsv(all.csv).rows.map((r) => r.cells[0] ?? '');
    const second = await exportProductsCsv(handle.db, { canSeeCost: false, after: skus[2] ?? '' });
    expect(parseCsv(second.csv).rows.map((r) => r.cells[0])).toEqual(skus.slice(3));
    expect(second.lastSku).toBe(skus.at(-1));
    expect(await exportParts(handle.db)).toEqual([]);
  });

  it('a file with a NUL byte or a repeated header is refused before anything is read into the database', () => {
    expect(() => parseCsv('sku,name\nA,b\u0000c')).toThrow();
    expect(() => parseCsv('sku,sku\nA,B')).toThrow();
  });
});

describe('export', () => {
  it('carries the cost column only for a role that may see it, and neutralises formulas', async () => {
    await importCsv([header, line(900, { nameEn: '=1+1', cost: '777.77' })].join('\n'));
    const owner = await exportProductsCsv(handle.db, { canSeeCost: true });
    const manager = await exportProductsCsv(handle.db, { canSeeCost: false });
    expect(owner.csv).toContain('cost_price');
    expect(owner.csv).toContain('777.77');
    expect(manager.csv).not.toContain('cost_price');
    expect(manager.csv).not.toContain('777.77');
    expect(manager.csv).not.toContain('cost');
    expect(owner.csv).toContain("'=1+1");
    const parsed = parseCsv(manager.csv);
    expect(parsed.header).not.toContain('cost_price');
    expect(manager.rows).toBeGreaterThan(90);
  });
});
