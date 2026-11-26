/**
 * CSV import of products: PREVIEW first (every row validated, nothing written), then COMMIT, which
 * applies the valid rows and reports the rest with their line numbers. A row is created or updated
 * by its SKU; an empty cell in an UPDATE leaves the field as it is. Each row is written in its own
 * savepoint through the same domain functions the editor uses (so the same rules apply: unique
 * slug and SKU, price over old price, 301 for a renamed slug) and writes its own audit row; one bad
 * row never undoes the good ones.
 *
 * Who may do what is decided by the CALLER (`catalog.import`) and passed in as `caps`: a column the
 * role may not write (the cost without `catalog.cost.view`, any price without `catalog.price`) turns
 * the row into an error instead of being ignored silently.
 */
import { inArray } from 'drizzle-orm';

import { categories, products } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { CONTENT_BOUNDS } from '@store/shared/content-bounds';
import {
  BASIC_COLUMNS,
  CONTENT_COLUMNS,
  EXAMPLE_SKU_PREFIX,
  NAME_COLUMNS,
} from '@store/shared/content-columns';
import { cleanText, visibleLength, visibleText } from '@store/shared/content-text';
import { money } from '@store/shared/money';

import { DomainError } from '../errors.ts';
import { unsafeCell, type ParsedCsv } from './csv.ts';
import type { AdminOutcome, AuditDraft } from './outcome.ts';
import { createProduct, updateProductContent, updateProductPricing } from './products.ts';
import { hryvnias, skuField, slugField } from './schemas.ts';

export type ImportErrorCode =
  | 'sku_required'
  | 'sku_invalid'
  | 'sku_duplicate_in_file'
  | 'slug_invalid'
  | 'name_required'
  | 'brand_required'
  | 'category_required'
  | 'category_unknown'
  | 'price_required'
  | 'price_invalid'
  | 'compare_price_invalid'
  | 'cost_invalid'
  | 'weight_invalid'
  | 'text_too_long'
  | 'price_forbidden'
  | 'cost_forbidden'
  | 'row_too_short'
  | 'example_row'
  | 'slug_taken'
  | 'slug_duplicate_in_file'
  | 'row_failed'
  | 'ADMIN_SLUG_TAKEN'
  | 'ADMIN_SKU_TAKEN'
  | 'ADMIN_INVALID_PRICE';

/** What the row will leave EMPTY or outside the guide after the import (advice, never an error). */
export interface ContentNote {
  column: string;
  code:
    | 'missing'
    | 'too_short'
    | 'too_long'
    | 'same_in_both_languages'
    | 'looks_like_tag'
    | 'needs_photos_and_variants';
}

export interface ImportRowResult {
  /** The line in the file (the header is line 1; a quoted text with line breaks spans several). */
  line: number;
  /** The data row, the way a spreadsheet numbers it below the header (first data row = 1). */
  row: number;
  /** For the errors that name a column: which one (`text_too_long`, `slug_invalid`). */
  errorColumns: Partial<Record<ImportErrorCode, string>>;
  sku: string;
  action: 'create' | 'update' | 'error';
  errors: ImportErrorCode[];
  notes: ContentNote[];
}

export interface ImportCaps {
  canPrice: boolean;
  canSeeCost: boolean;
}

interface Planned {
  line: number;
  sku: string;
  action: 'create' | 'update';
  existingId: string | null;
  slug: string | null;
  brand: string | null;
  categoryId: string | null;
  nameUk: string | null;
  nameEn: string | null;
  price: number | null;
  compareAt: number | null | undefined;
  cost: number | null | undefined;
  weight: number | null;
  /** Content cells present in the file, by the key of `productContentSchema`. */
  content: Record<string, string>;
}

const KNOWN_COLUMNS: readonly string[] = [
  ...BASIC_COLUMNS,
  ...CONTENT_COLUMNS.map((c) => c.column),
];

export interface ImportPlan {
  results: ImportRowResult[];
  planned: Planned[];
  /** Header names that are not importable columns: reported, never silently used. */
  ignoredColumns: string[];
  /** Content columns the file does not have at all (every row's text there stays as it is, or empty). */
  absentColumns: string[];
}

/** An ASCII slug from a name, or from the SKU when the name has nothing to keep. */
export function slugify(name: string, fallback: string): string {
  const make = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200);
  return make(name) || make(fallback) || 'product';
}

const empty = (value: string | undefined): boolean => (value ?? '').trim() === '';

const NOTE_COLUMNS = [
  ...NAME_COLUMNS.map((column) => ({ column, bound: 'name' as const })),
  ...CONTENT_COLUMNS.map((c) => ({ column: c.column, bound: c.bound })),
];
const COPY_PAIRS = CONTENT_COLUMNS.filter((c) => c.column.endsWith('_uk')).map((c) => ({
  uk: c.column,
  en: c.column.replace(/_uk$/, '_en'),
}));

/**
 * What the product will have after this row, against the guide's bounds: a cell left empty keeps
 * the stored text (an update), so the stored text counts. Advice for the preview, never an error
 * (a draft with gaps is a normal state); the same bounds and the same visible-text rule as the
 * readiness report.
 */
function contentNotes(
  fileCell: (column: string) => string,
  stored: Readonly<Record<string, string | null>> | undefined,
): ContentNote[] {
  const text = (column: string): string => {
    const fromFile = fileCell(column);
    if (fromFile !== '') return fromFile;
    return stored?.[column] ?? '';
  };
  const notes: ContentNote[] = [];
  for (const { column, bound } of NOTE_COLUMNS) {
    const length = visibleLength(text(column));
    const limits = CONTENT_BOUNDS[bound];
    if (length === 0) notes.push({ column, code: 'missing' });
    else if (length < limits.min) notes.push({ column, code: 'too_short' });
    else if (length > limits.max) notes.push({ column, code: 'too_long' });
  }
  for (const pair of COPY_PAIRS) {
    const uk = visibleText(text(pair.uk)).toLowerCase();
    if (uk !== '' && uk === visibleText(text(pair.en)).toLowerCase())
      notes.push({ column: pair.uk.replace(/_uk$/, ''), code: 'same_in_both_languages' });
  }
  return notes;
}

/** Anything the template's example row carries: its SKU (any case), its marker words, its slug. */
const EXAMPLE_MARKER = /\[(?:EXAMPLE|ПРИКЛАД)\]/i;
const EXAMPLE_SLUG = 'example-latin-words-with-hyphens';
const looksLikeTag = (value: string): boolean => /<\/?[a-zA-Z][^>]*>/.test(value);

export async function planImport(
  db: Reader,
  parsed: ParsedCsv,
  caps: ImportCaps,
): Promise<ImportPlan> {
  const index = new Map(parsed.header.map((name, position) => [name, position]));
  const ignoredColumns = parsed.header.filter(
    (name) => name !== '' && !KNOWN_COLUMNS.includes(name),
  );
  const absentColumns = CONTENT_COLUMNS.map((c) => c.column).filter((name) => !index.has(name));
  const cell = (cells: readonly string[], name: string): string | undefined => {
    const position = index.get(name);
    // A cell this shop exported with a leading apostrophe (formula neutralising) is read back as it was.
    return position === undefined
      ? undefined
      : cleanText(unsafeCell((cells[position] ?? '').trim())).trim();
  };

  const skus = [
    ...new Set(parsed.rows.map((row) => cell(row.cells, 'sku') ?? '').filter((v) => v !== '')),
  ];
  const slugs = [
    ...new Set(parsed.rows.map((row) => cell(row.cells, 'category') ?? '').filter((v) => v !== '')),
  ];
  const existing =
    skus.length === 0
      ? []
      : await db
          .select({
            id: products.id,
            sku: products.sku,
            // The text the product has now: an update that leaves a cell empty keeps it, so a
            // note about a "missing" text must look here too.
            name_uk: products.nameUk,
            name_en: products.nameEn,
            short_description_uk: products.shortDescriptionUk,
            short_description_en: products.shortDescriptionEn,
            description_uk: products.descriptionUk,
            description_en: products.descriptionEn,
            composition_uk: products.compositionUk,
            composition_en: products.compositionEn,
            care_uk: products.careUk,
            care_en: products.careEn,
            meta_title_uk: products.metaTitleUk,
            meta_title_en: products.metaTitleEn,
            meta_description_uk: products.metaDescriptionUk,
            meta_description_en: products.metaDescriptionEn,
          })
          .from(products)
          .where(inArray(products.sku, skus));
  const cats =
    slugs.length === 0
      ? []
      : await db
          .select({ id: categories.id, slug: categories.slug })
          .from(categories)
          .where(inArray(categories.slug, slugs));
  // Slugs this file will use: an explicit one, or the one a new row's English name generates.
  const wantedSlugs = [
    ...new Set(
      parsed.rows.flatMap((row) => {
        const sku = cell(row.cells, 'sku') ?? '';
        const slug = cell(row.cells, 'slug') ?? '';
        if (slug !== '') return [slug];
        if (existing.some((e) => e.sku === sku) || sku === '') return [];
        return [slugify(cell(row.cells, 'name_en') ?? '', sku)];
      }),
    ),
  ];
  const slugOwners =
    wantedSlugs.length === 0
      ? []
      : await db
          .select({ slug: products.slug, sku: products.sku })
          .from(products)
          .where(inArray(products.slug, wantedSlugs));
  const ownerOfSlug = new Map(slugOwners.map((row) => [row.slug, row.sku]));
  const slugUsedInFile = new Map<string, string>();
  const byId = new Map(existing.map((row) => [row.sku, row.id]));
  const current = new Map(existing.map((row) => [row.sku, row]));
  const byCategory = new Map(cats.map((row) => [row.slug, row.id]));

  const results: ImportRowResult[] = [];
  const planned: Planned[] = [];
  const seen = new Set<string>();

  let rowNumber = 0;
  for (const row of parsed.rows) {
    rowNumber += 1;
    const errors: ImportErrorCode[] = [];
    const sku = cell(row.cells, 'sku') ?? '';
    if (row.cells.length < parsed.header.length) errors.push('row_too_short');
    const errorColumns: Partial<Record<ImportErrorCode, string>> = {};
    if (
      sku.toUpperCase().startsWith(EXAMPLE_SKU_PREFIX) ||
      cell(row.cells, 'slug') === EXAMPLE_SLUG ||
      row.cells.some((value) => EXAMPLE_MARKER.test(value))
    )
      errors.push('example_row');
    else if (sku === '') errors.push('sku_required');
    else if (!skuField.safeParse(sku).success) errors.push('sku_invalid');
    else if (seen.has(sku)) errors.push('sku_duplicate_in_file');
    seen.add(sku);

    const existingId = byId.get(sku) ?? null;
    const action = existingId === null ? 'create' : 'update';
    const text = (name: string, max: number): string | null => {
      const value = cell(row.cells, name);
      if (value === undefined || value === '') return null;
      if (Array.from(value).length > max) {
        errors.push('text_too_long');
        errorColumns.text_too_long ??= name;
      }
      return value;
    };
    const slug = cell(row.cells, 'slug');
    if (!empty(slug) && !slugField.safeParse(slug).success) {
      errors.push('slug_invalid');
      errorColumns.slug_invalid = 'slug';
    }
    const brand = text('brand', 120);
    const nameUk = text('name_uk', 300);
    const nameEn = text('name_en', 300);
    const categorySlug = cell(row.cells, 'category');
    const categoryId = empty(categorySlug) ? null : (byCategory.get(categorySlug ?? '') ?? null);
    if (!empty(categorySlug) && categoryId === null) errors.push('category_unknown');

    const money = (name: string, bad: ImportErrorCode): number | null | undefined => {
      const value = cell(row.cells, name);
      if (value === undefined) return undefined;
      if (value === '') return undefined;
      const result = hryvnias.safeParse(value);
      if (!result.success || result.data < 0) {
        errors.push(bad);
        return undefined;
      }
      return result.data;
    };
    const price = money('price', 'price_invalid');
    const compareAt = money('compare_at_price', 'compare_price_invalid');
    const cost = money('cost_price', 'cost_invalid');
    if (price === 0) errors.push('price_invalid');
    if ((price !== undefined || compareAt !== undefined) && !caps.canPrice)
      errors.push('price_forbidden');
    if (cost !== undefined && !(caps.canPrice && caps.canSeeCost)) errors.push('cost_forbidden');
    const weightText = cell(row.cells, 'weight_grams');
    let weight: number | null = null;
    if (weightText !== undefined && weightText !== '') {
      const value = Number(weightText);
      if (!Number.isInteger(value) || value < 1 || value > 50_000) errors.push('weight_invalid');
      else weight = value;
    }

    const content: Record<string, string> = {};
    for (const column of CONTENT_COLUMNS) {
      const value = cell(row.cells, column.column);
      if (value === undefined || value === '') continue;
      if (Array.from(value).length > column.dbMax) {
        errors.push('text_too_long');
        errorColumns.text_too_long ??= column.column;
      } else content[column.key] = value;
    }

    if (action === 'create') {
      if (nameUk === null || nameEn === null) errors.push('name_required');
      if (brand === null) errors.push('brand_required');
      if (empty(categorySlug)) errors.push('category_required');
      if (price === undefined || price === null) errors.push('price_required');
    }

    // The slug this row will end up with (explicit, or generated for a new product): a collision is
    // reported NOW, in the preview, never first at the commit.
    const finalSlug = !empty(slug)
      ? (slug ?? '')
      : action === 'create' && sku !== ''
        ? slugify(nameEn ?? '', sku)
        : null;
    if (finalSlug !== null && slugField.safeParse(finalSlug).success) {
      const owner = ownerOfSlug.get(finalSlug);
      if (owner !== undefined && owner !== sku) {
        errors.push('slug_taken');
        errorColumns.slug_taken = 'slug';
      } else if (slugUsedInFile.has(finalSlug) && slugUsedInFile.get(finalSlug) !== sku) {
        errors.push('slug_duplicate_in_file');
        errorColumns.slug_duplicate_in_file = 'slug';
      } else slugUsedInFile.set(finalSlug, sku);
    }

    const unique = [...new Set(errors)];
    if (unique.length > 0) {
      results.push({
        line: row.line,
        row: rowNumber,
        sku,
        action: 'error',
        errors: unique,
        errorColumns,
        notes: [],
      });
      continue;
    }
    const notes = contentNotes((name) => cell(row.cells, name) ?? '', current.get(sku));
    for (const column of CONTENT_COLUMNS)
      if (looksLikeTag(cell(row.cells, column.column) ?? ''))
        notes.push({ column: column.column, code: 'looks_like_tag' });
    // A product made from a CSV is a draft without variants or photos until the card is filled in.
    if (action === 'create') notes.push({ column: 'photos', code: 'needs_photos_and_variants' });
    results.push({
      line: row.line,
      row: rowNumber,
      sku,
      action,
      errors: [],
      errorColumns: {},
      notes,
    });
    planned.push({
      line: row.line,
      sku,
      action,
      existingId,
      slug: empty(slug) ? null : (slug ?? null),
      brand,
      categoryId,
      nameUk,
      nameEn,
      price: price ?? null,
      compareAt: compareAt === undefined ? undefined : compareAt,
      cost: cost === undefined ? undefined : cost,
      weight,
      content,
    });
  }
  return { results, planned, ignoredColumns, absentColumns };
}

/**
 * An import writes up to 1000 rows of up to 12 long texts: the audit row says WHICH text changed and
 * how long it is now, never the text itself (one upload could otherwise write tens of MB to the log).
 */
function slimDiff(diff: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(diff).map(([key, value]) => {
      const to =
        typeof value === 'object' && value !== null && 'to' in value ? value.to : undefined;
      return typeof to === 'string' && to.length > 200
        ? [key, { changed: true, length: to.length }]
        : [key, value];
    }),
  );
}

export interface ImportOutcome {
  results: ImportRowResult[];
  created: number;
  updated: number;
  failed: number;
}

/** Writes the planned rows, each in its own savepoint. Returns the outcome with one audit row per written row. */
export async function applyImport(
  tx: Tx,
  plan: ImportPlan,
  summaryEntityId: string,
): Promise<AdminOutcome<ImportOutcome>> {
  const results = new Map<number, ImportRowResult>(plan.results.map((row) => [row.line, row]));
  const audits: AuditDraft[] = [];
  const tags = new Set<string>();
  let created = 0;
  let updated = 0;

  // In SKU order: two imports running at once then take their row locks in the same order.
  const ordered = [...plan.planned].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  for (const row of ordered) {
    try {
      const state = { changed: false };
      await tx.transaction(async (inner) => {
        const outcomes: AdminOutcome<unknown>[] = [];
        let productId = row.existingId;
        if (row.action === 'create') {
          const made = await createProduct(inner, {
            sku: row.sku,
            slug: row.slug ?? slugify(row.nameEn ?? '', row.sku),
            brand: row.brand ?? '',
            categoryId: row.categoryId ?? '',
            nameUk: row.nameUk ?? '',
            nameEn: row.nameEn ?? '',
            basePrice: money(row.price ?? 0),
            costPrice: row.cost === undefined || row.cost === null ? null : money(row.cost),
            weightGrams: row.weight ?? 200,
          });
          productId = made.data.productId;
          outcomes.push(made);
          if (Object.keys(row.content).length > 0)
            outcomes.push(await updateProductContent(inner, { productId, ...row.content }));
          if (row.compareAt !== undefined && row.compareAt !== null) {
            outcomes.push(
              await updateProductPricing(inner, {
                productId,
                compareAtPrice: money(row.compareAt),
              }),
            );
          }
        } else if (productId !== null) {
          outcomes.push(
            await updateProductContent(inner, {
              productId,
              ...(row.slug === null ? {} : { slug: row.slug }),
              ...(row.brand === null ? {} : { brand: row.brand }),
              ...(row.categoryId === null ? {} : { categoryId: row.categoryId }),
              ...(row.nameUk === null ? {} : { nameUk: row.nameUk }),
              ...(row.nameEn === null ? {} : { nameEn: row.nameEn }),
              ...(row.weight === null ? {} : { weightGrams: row.weight }),
              ...row.content,
            }),
          );
          if (row.price !== null || row.compareAt !== undefined || row.cost !== undefined) {
            outcomes.push(
              await updateProductPricing(inner, {
                productId,
                ...(row.price === null ? {} : { basePrice: money(row.price) }),
                ...(row.compareAt === undefined
                  ? {}
                  : { compareAtPrice: row.compareAt === null ? null : money(row.compareAt) }),
                ...(row.cost === undefined
                  ? {}
                  : { costPrice: row.cost === null ? null : money(row.cost) }),
              }),
            );
          }
        }
        for (const outcome of outcomes) {
          if (outcome.audit.action !== 'update' || Object.keys(outcome.audit.diff).length > 0) {
            audits.push({
              ...outcome.audit,
              diff: { ...slimDiff(outcome.audit.diff), importLine: row.line },
            });
            state.changed = true;
          }
          for (const tag of outcome.tags) tags.add(tag);
        }
      });
      if (row.action === 'create') created += 1;
      // A row that changed nothing (an unchanged export imported back) is not an update.
      else if (state.changed) updated += 1;
    } catch (error) {
      const code: ImportErrorCode =
        error instanceof DomainError &&
        (error.code === 'ADMIN_SLUG_TAKEN' ||
          error.code === 'ADMIN_SKU_TAKEN' ||
          error.code === 'ADMIN_INVALID_PRICE')
          ? error.code
          : 'row_failed';
      const previous = results.get(row.line);
      results.set(row.line, {
        line: row.line,
        row: previous?.row ?? 0,
        sku: row.sku,
        action: 'error',
        errors: [code],
        errorColumns: code === 'ADMIN_SLUG_TAKEN' ? { ADMIN_SLUG_TAKEN: 'slug' } : {},
        notes: [],
      });
    }
  }

  const finalResults = [...results.values()].sort((a, b) => a.line - b.line);
  const failed = finalResults.filter((row) => row.action === 'error').length;
  return {
    data: { results: finalResults, created, updated, failed },
    audit: {
      action: 'create',
      entity: 'product_import',
      entityId: summaryEntityId,
      diff: { created, updated, failed },
    },
    extraAudits: audits,
    tags: [...tags],
  };
}
