/**
 * The content columns of the CSV import on real Postgres: texts are written and kept like the
 * editor would, the preview names what will still be empty (with the same visible-text rule as the
 * readiness report), the template's example row never loads, and an export can be imported back.
 */
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { categories, products } from '@store/db/schema';
import { CONTENT_BOUNDS } from '@store/shared/content-bounds';
import { CONTENT_COLUMNS, EXAMPLE_SKU_PREFIX } from '@store/shared/content-columns';
import { visibleLength } from '@store/shared/content-text';

import { parseCsv } from '../src/catalog-admin/csv.ts';
import { exportProductsCsv } from '../src/catalog-admin/export.ts';
import { applyImport, planImport } from '../src/catalog-admin/import.ts';
import { productContentSchema } from '../src/catalog-admin/schemas.ts';
import { contentTemplateCsv, TEMPLATE_HEADER } from '../src/catalog-admin/template.ts';
import { norm } from '../src/content-readiness/read.ts';
import { filler } from './content-fixture.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let handle: DbHandle;
let category = '';
const ALL = { canPrice: true, canSeeCost: true } as const;

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(4);
  const [row] = await handle.db.select({ slug: categories.slug }).from(categories).limit(1);
  category = row?.slug ?? '';
});
afterAll(async () => {
  await world.close();
});

const importCsv = async (text: string) => {
  const plan = await planImport(handle.db, parseCsv(text), ALL);
  const outcome = await handle.db.transaction(async (tx) => await applyImport(tx, plan, 'batch-c'));
  return { plan, outcome };
};
const bySku = async (sku: string) =>
  (await handle.db.select().from(products).where(eq(products.sku, sku)))[0];

const COLUMN_NAMES = CONTENT_COLUMNS.map((c) => c.column);
const fullRow = (sku: string, over: Record<string, string> = {}): Record<string, string> => ({
  sku,
  slug: sku.toLowerCase(),
  brand: 'Brand',
  category,
  name_uk: `Назва ${sku}`,
  name_en: `Name ${sku}`,
  price: '499.00',
  ...Object.fromEntries(
    CONTENT_COLUMNS.map((c) => [
      c.column,
      filler(
        `${c.column} ${sku}`,
        Math.min(CONTENT_BOUNDS[c.bound].max, CONTENT_BOUNDS[c.bound].min + 25),
      ),
    ]),
  ),
  ...over,
});
const csvOf = (rows: Record<string, string>[], columns?: string[]): string => {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const cell = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c] ?? '')).join(','))].join(
    '\n',
  );
};

describe('content columns', () => {
  it('every content column writes a key the product content schema accepts', () => {
    const keys = Object.keys(productContentSchema.shape);
    for (const column of CONTENT_COLUMNS) expect(keys).toContain(column.key);
  });

  it('a create writes every text; the product is a draft', async () => {
    const { outcome } = await importCsv(csvOf([fullRow('CT-1')]));
    expect(outcome.data).toMatchObject({ created: 1, failed: 0 });
    const row = await bySku('CT-1');
    expect(row?.isActive).toBe(false);
    for (const c of CONTENT_COLUMNS) {
      const stored = Object.entries(row ?? {}).find(([k]) => k === c.key)?.[1];
      expect(stored).toBe(fullRow('CT-1')[c.column]?.trim());
    }
  });

  it('an update: an empty cell keeps the text, a filled one replaces it, an absent column is untouched', async () => {
    await importCsv(csvOf([fullRow('CT-2')]));
    const before = await bySku('CT-2');
    await importCsv(
      csvOf(
        [{ sku: 'CT-2', description_uk: '', care_en: 'New care text for the update' }],
        ['sku', 'description_uk', 'care_en'],
      ),
    );
    const after = await bySku('CT-2');
    expect(after?.descriptionUk).toBe(before?.descriptionUk);
    expect(after?.careEn).toBe('New care text for the update');
    expect(after?.metaTitleEn).toBe(before?.metaTitleEn);
  });

  it('a text over the database limit is an error naming text_too_long, the rest still import', async () => {
    const rows = [fullRow('CT-3', { meta_title_uk: 'x'.repeat(201) }), fullRow('CT-4')];
    const { outcome } = await importCsv(csvOf(rows));
    expect(outcome.data.results.map((r) => r.errors)).toEqual([['text_too_long'], []]);
    expect(await bySku('CT-3')).toBeUndefined();
    expect(await bySku('CT-4')).toBeDefined();
  });
});

describe('the preview names what will still be empty', () => {
  it('a create with blanks: each empty content column is a note, an error row has none', async () => {
    const plan = await planImport(
      handle.db,
      parseCsv(
        csvOf([
          fullRow('CT-5', { meta_description_en: '', care_uk: '   ' }),
          fullRow('CT-6', { price: 'abc' }),
        ]),
      ),
      ALL,
    );
    const [first, second] = plan.results;
    expect(first?.notes).toEqual(
      expect.arrayContaining([
        { column: 'care_uk', code: 'missing' },
        { column: 'meta_description_en', code: 'missing' },
      ]),
    );
    expect(first?.notes.length).toBe(2);
    expect(second?.errors).toContain('price_invalid');
    expect(second?.notes).toEqual([]);
  });

  it('an update counts the stored text: a cell left empty is not "missing" when the product has it', async () => {
    await importCsv(csvOf([fullRow('CT-7')]));
    const plan = await planImport(
      handle.db,
      parseCsv(csvOf([{ sku: 'CT-7', description_uk: '' }], ['sku', 'description_uk'])),
      ALL,
    );
    expect(plan.results[0]?.notes).toEqual([]);
    expect(plan.absentColumns).toContain('meta_title_uk');
    expect(plan.absentColumns).not.toContain('description_uk');
  });

  it('zero-width and blank-only cells are missing, short and long and copied text are advised', async () => {
    const plan = await planImport(
      handle.db,
      parseCsv(
        csvOf([
          fullRow('CT-8', {
            meta_title_uk: '​'.repeat(30),
            meta_description_uk: 'short',
            description_uk: 'x'.repeat(CONTENT_BOUNDS.description.max + 1),
            care_uk: 'Прати при 30 градусах окремо',
            care_en: 'Прати при 30 градусах окремо',
          }),
        ]),
      ),
      ALL,
    );
    const notes = plan.results[0]?.notes ?? [];
    expect(notes).toEqual(
      expect.arrayContaining([
        { column: 'meta_title_uk', code: 'missing' },
        { column: 'meta_description_uk', code: 'too_short' },
        { column: 'description_uk', code: 'too_long' },
        { column: 'care', code: 'same_in_both_languages' },
      ]),
    );
  });
});

describe('the template', () => {
  it('has the header the import knows, one example row, and loads nothing when uploaded as it is', async () => {
    const parsed = parseCsv(contentTemplateCsv());
    expect(parsed.header).toEqual([...TEMPLATE_HEADER]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.cells[0]?.startsWith(EXAMPLE_SKU_PREFIX)).toBe(true);
    const before = (await handle.db.select({ id: products.id }).from(products)).length;
    const plan = await planImport(handle.db, parsed, ALL);
    expect(plan.ignoredColumns).toEqual([]);
    expect(plan.absentColumns).toEqual([]);
    expect(plan.results[0]?.action).toBe('error');
    expect(plan.results[0]?.errors).toContain('example_row');
    const { outcome } = await importCsv(contentTemplateCsv());
    expect(outcome.data).toMatchObject({ created: 0, updated: 0, failed: 1 });
    expect((await handle.db.select({ id: products.id }).from(products)).length).toBe(before);
  });

  it('every content column of the template is a column of the export (fill, import, export again)', async () => {
    const exported = await exportProductsCsv(handle.db, { canSeeCost: false });
    const header = parseCsv(exported.csv).header;
    for (const column of COLUMN_NAMES) expect(header).toContain(column);
  });
});

describe('export and import round trip', () => {
  it('importing the export again changes nothing', async () => {
    const exported = await exportProductsCsv(handle.db, { canSeeCost: true });
    const before = await handle.db.select().from(products);
    const { outcome } = await importCsv(exported.csv);
    expect(outcome.data.failed).toBe(0);
    expect(outcome.data.created).toBe(0);
    const after = await handle.db.select().from(products);
    expect(after.map((p) => [p.id, p.updatedAt.getTime()])).toEqual(
      before.map((p) => [p.id, p.updatedAt.getTime()]),
    );
  });
});

describe('the preview and the readiness report measure alike', () => {
  const samples = [
    '',
    '   ',
    'plain text',
    '​‌‍',
    ' ',
    'a  b',
    'tab\tand\nnewline',
    'Українська мова',
    '😀 emoji',
    ' em space　',
    'x y',
    '﻿bom',
  ];
  it('the same length in TypeScript and in SQL for every sample', async () => {
    for (const value of samples) {
      const result = await handle.db.execute(
        sql`SELECT char_length(${sql.raw(norm('v.t'))}) AS n FROM (SELECT ${value}::text AS t) v`,
      );
      expect([value, Number(result.rows[0]?.['n'])]).toEqual([value, visibleLength(value)]);
    }
  });
});
