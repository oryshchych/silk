/**
 * The report: every product and category judged ONCE (`computeContentReadiness`, the expensive part:
 * a few set-based queries over the whole catalogue), then cut into a VIEW (`reportView`: a filter,
 * a page) for the screen or the CLI. The filter runs BEFORE the page is cut, so "needs work" is the
 * whole list of products that need work, never what is left after a cap; totals always cover all.
 */
import { sql } from 'drizzle-orm';

import type { Reader } from '@store/db/types';
import {
  contentReadinessDto,
  type AcceptanceCheck,
  type CategoryReadinessDto,
  type ContentReadinessDto,
  type PhotoProblemDto,
  type ProductReadinessDto,
} from '@store/shared/dto/content-readiness';
import { serialize } from '@store/shared/dto/serialize';

import { readCategoryFacts, readPhotos, readProductFacts } from './read.ts';
import { toCategoryReadiness, toProductReadiness } from './rules.ts';

export const DEFAULT_EXPECTED_ACTIVE = 40;
/** Products listed in one page of the CLI report (the screen pages by its own size). */
export const REPORT_PRODUCT_LIMIT = 2_000;

export type ReportShow = 'todo' | 'all' | 'drafts';

export interface ReadinessOptions {
  /** How many ready live products the launch needs (the plan says 40). */
  expectedActive?: number;
  now?: Date;
  /** Only inside a transaction: `SET LOCAL statement_timeout`, so a slow report cannot hold its connection. */
  statementTimeoutMs?: number;
}

export interface ComputedReadiness {
  generatedAt: string;
  expectedActive: number;
  totals: ContentReadinessDto['totals'];
  acceptance: AcceptanceCheck[];
  gatePassed: boolean;
  /** Every product, the ones that are not ready first (then by SKU). */
  products: ProductReadinessDto[];
  categories: CategoryReadinessDto[];
  photoProblems: PhotoProblemDto[];
  photoProblemsTruncated: boolean;
}

export async function computeContentReadiness(
  db: Reader,
  options: ReadinessOptions = {},
): Promise<ComputedReadiness> {
  const expectedActive = options.expectedActive ?? DEFAULT_EXPECTED_ACTIVE;
  if (options.statementTimeoutMs !== undefined) {
    await db.execute(
      sql.raw(`SET LOCAL statement_timeout = ${String(Math.trunc(options.statementTimeoutMs))}`),
    );
  }
  // One after another: a `Reader` may be a single transaction connection, which runs one query at a time.
  const facts = await readProductFacts(db);
  const categoryFacts = await readCategoryFacts(db);
  const photos = await readPhotos(db);
  const all = facts.map(toProductReadiness);
  const categories = categoryFacts.map(toCategoryReadiness);
  const active = all.filter((row) => row.isActive);
  const activeCategories = categories.filter((row) => row.isActive);
  const drafts = all.filter((row) => !row.isActive);
  const live = all.filter((row) => row.live);

  const has = (row: ProductReadinessDto, codes: readonly string[]): boolean =>
    row.findings.some((entry) => entry.severity === 'blocker' && codes.includes(entry.code));
  const violations = (count: number, id: AcceptanceCheck['id']): AcceptanceCheck => ({
    id,
    actual: count,
    expected: 0,
    ok: count === 0,
  });
  const missingMeta = (row: ProductReadinessDto): boolean =>
    row.findings.some((entry) => entry.code === 'missing' && entry.field === 'meta_description');
  const acceptance: AcceptanceCheck[] = [
    // Ready, not merely shown: a live product with a blocker is not one of the forty.
    {
      id: 'active_products',
      ok: live.filter((row) => row.ready).length >= expectedActive,
      actual: live.filter((row) => row.ready).length,
      expected: expectedActive,
    },
    violations(
      active.filter((row) => has(row, ['no_active_variant', 'no_stock', 'no_photo'])).length,
      'variants_stock_photos',
    ),
    // The plan's wording: no product without a photo, an alt text or a meta description.
    violations(
      active.filter(
        (row) =>
          has(row, ['no_photo', 'photo_alt_missing', 'photo_alt_too_short']) || missingMeta(row),
      ).length,
      'alt_meta_photo',
    ),
    violations(
      activeCategories.filter((row) =>
        row.findings.some(
          (entry) =>
            entry.field === 'seo_text' && entry.code === 'missing' && entry.severity === 'blocker',
        ),
      ).length,
      'category_seo_text',
    ),
    // Everything else the rules call a blocker (bounds, copied snippets, renditions, hidden state ...).
    violations(
      active.filter((row) => !row.ready).length +
        activeCategories.filter((row) => !row.ready).length,
      'no_blockers',
    ),
  ];

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    expectedActive,
    totals: {
      products: all.length,
      live: live.length,
      liveReady: live.filter((row) => row.ready).length,
      active: active.length,
      activeReady: active.filter((row) => row.ready).length,
      drafts: drafts.length,
      draftsReady: drafts.filter((row) => row.ready).length,
      categories: activeCategories.length,
      categoriesReady: activeCategories.filter((row) => row.ready).length,
      photos: photos.total,
      photosWithProblems: photos.problems,
    },
    acceptance,
    gatePassed: acceptance.every((check) => check.ok),
    products: [...all.filter((row) => !row.ready), ...all.filter((row) => row.ready)],
    categories,
    photoProblems: photos.list,
    photoProblemsTruncated: photos.truncated,
  };
}

/** What each view of the product list holds. */
export function matchesShow(row: ProductReadinessDto, show: ReportShow): boolean {
  if (show === 'all') return true;
  if (show === 'drafts') return !row.isActive;
  return row.isActive && (!row.ready || !row.live);
}

export interface ReportView {
  show: ReportShow;
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** A filter, then a page: the DTO the screen and the CLI serialise. */
export function reportView(computed: ComputedReadiness, view: ReportView): ContentReadinessDto {
  const matching = computed.products.filter((row) => matchesShow(row, view.show));
  const pages = Math.max(1, Math.ceil(matching.length / view.pageSize));
  const page = Math.min(Math.max(1, view.page), pages);
  const start = (page - 1) * view.pageSize;
  return serialize(contentReadinessDto, {
    ...computed,
    show: view.show,
    page,
    pageSize: view.pageSize,
    pages,
    matchingProducts: matching.length,
    products: matching.slice(start, start + view.pageSize),
    productsTruncated: matching.length > view.pageSize && page === 1,
  });
}

/** The CLI and the tests: compute and take the first page of everything. */
export async function readContentReadiness(
  db: Reader,
  options: ReadinessOptions & { show?: ReportShow; page?: number; pageSize?: number } = {},
): Promise<ContentReadinessDto> {
  const computed = await computeContentReadiness(db, options);
  return reportView(computed, {
    show: options.show ?? 'all',
    page: options.page ?? 1,
    pageSize: options.pageSize ?? REPORT_PRODUCT_LIMIT,
  });
}
