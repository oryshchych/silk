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
import { money } from '@store/shared/money';

import { DomainError } from '../errors.ts';
import type { ParsedCsv } from './csv.ts';
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
  | 'row_failed'
  | 'ADMIN_SLUG_TAKEN'
  | 'ADMIN_SKU_TAKEN'
  | 'ADMIN_INVALID_PRICE';

export interface ImportRowResult {
  line: number;
  sku: string;
  action: 'create' | 'update' | 'error';
  errors: ImportErrorCode[];
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
}

const KNOWN_COLUMNS = [
  'sku',
  'slug',
  'brand',
  'category',
  'name_uk',
  'name_en',
  'price',
  'compare_at_price',
  'cost_price',
  'weight_grams',
] as const;

export interface ImportPlan {
  results: ImportRowResult[];
  planned: Planned[];
  /** Header names that are not importable columns: reported, never silently used. */
  ignoredColumns: string[];
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

export async function planImport(
  db: Reader,
  parsed: ParsedCsv,
  caps: ImportCaps,
): Promise<ImportPlan> {
  const index = new Map(parsed.header.map((name, position) => [name, position]));
  const ignoredColumns = parsed.header.filter(
    (name) => name !== '' && !(KNOWN_COLUMNS as readonly string[]).includes(name),
  );
  const cell = (cells: readonly string[], name: string): string | undefined => {
    const position = index.get(name);
    return position === undefined ? undefined : (cells[position] ?? '').trim();
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
          .select({ id: products.id, sku: products.sku })
          .from(products)
          .where(inArray(products.sku, skus));
  const cats =
    slugs.length === 0
      ? []
      : await db
          .select({ id: categories.id, slug: categories.slug })
          .from(categories)
          .where(inArray(categories.slug, slugs));
  const byId = new Map(existing.map((row) => [row.sku, row.id]));
  const byCategory = new Map(cats.map((row) => [row.slug, row.id]));

  const results: ImportRowResult[] = [];
  const planned: Planned[] = [];
  const seen = new Set<string>();

  for (const row of parsed.rows) {
    const errors: ImportErrorCode[] = [];
    const sku = cell(row.cells, 'sku') ?? '';
    if (row.cells.length < parsed.header.length) errors.push('row_too_short');
    if (sku === '') errors.push('sku_required');
    else if (!skuField.safeParse(sku).success) errors.push('sku_invalid');
    else if (seen.has(sku)) errors.push('sku_duplicate_in_file');
    seen.add(sku);

    const existingId = byId.get(sku) ?? null;
    const action = existingId === null ? 'create' : 'update';
    const text = (name: string, max: number): string | null => {
      const value = cell(row.cells, name);
      if (value === undefined || value === '') return null;
      if (value.length > max) errors.push('text_too_long');
      return value;
    };
    const slug = cell(row.cells, 'slug');
    if (!empty(slug) && !slugField.safeParse(slug).success) errors.push('slug_invalid');
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

    if (action === 'create') {
      if (nameUk === null || nameEn === null) errors.push('name_required');
      if (brand === null) errors.push('brand_required');
      if (empty(categorySlug)) errors.push('category_required');
      if (price === undefined || price === null) errors.push('price_required');
    }

    const unique = [...new Set(errors)];
    if (unique.length > 0) {
      results.push({ line: row.line, sku, action: 'error', errors: unique });
      continue;
    }
    results.push({ line: row.line, sku, action, errors: [] });
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
    });
  }
  return { results, planned, ignoredColumns };
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

  for (const row of plan.planned) {
    try {
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
              diff: { ...outcome.audit.diff, importLine: row.line },
            });
          }
          for (const tag of outcome.tags) tags.add(tag);
        }
      });
      if (row.action === 'create') created += 1;
      else updated += 1;
    } catch (error) {
      const code: ImportErrorCode =
        error instanceof DomainError &&
        (error.code === 'ADMIN_SLUG_TAKEN' ||
          error.code === 'ADMIN_SKU_TAKEN' ||
          error.code === 'ADMIN_INVALID_PRICE')
          ? error.code
          : 'row_failed';
      results.set(row.line, { line: row.line, sku: row.sku, action: 'error', errors: [code] });
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
