/**
 * Pure helpers of `pnpm content:check` (`scripts/content-check.ts`): which database the checker
 * may open, and the human summary. Kept here so both are unit-tested without a process or a
 * database.
 */
import type { ContentReadinessDto, FindingDto } from '@store/shared/dto/content-readiness';

export class UnsafeTargetError extends Error {
  constructor(reason: string) {
    super(`content:check refused: ${reason}`);
    this.name = 'UnsafeTargetError';
  }
}

/** A word `prod` or `production` in the host, database name or user of the URL. */
const PRODUCTION_WORD = /(^|[^a-z0-9])prod(uction)?($|[^a-z0-9])/i;

/**
 * The checker only reads (the caller opens a read-only transaction), and on top of that it refuses
 * a database that looks like production unless the process itself runs in production
 * (`APP_ENV=production`, the production container reading its own database). A heuristic, not a
 * wall: the wall is the read-only transaction and keeping production credentials out of dev
 * machines (`docs/AI_SETUP.md`).
 */
export function assertSafeTarget(databaseUrl: string | undefined, appEnv: string | undefined): URL {
  if (databaseUrl === undefined || databaseUrl.trim() === '')
    throw new UnsafeTargetError('DATABASE_URL is not set');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UnsafeTargetError('DATABASE_URL is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new UnsafeTargetError('DATABASE_URL is not a postgres URL');
  if (appEnv !== 'production') {
    const haystack = [
      url.hostname,
      decodeURIComponent(url.pathname),
      decodeURIComponent(url.username),
    ];
    if (haystack.some((part) => PRODUCTION_WORD.test(part)))
      throw new UnsafeTargetError(
        'the database looks like production and this is not a production process',
      );
  }
  return url;
}

/** Terminal-safe text: staff input must not carry escape sequences into a terminal or a log. */
export const plain = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');

const describe = (entry: FindingDto): string => {
  const parts: string[] = [entry.code];
  if (entry.field !== null) parts.push(entry.field);
  if (entry.locale !== null) parts.push(entry.locale);
  const text = parts.join(':');
  return entry.count === null ? text : `${text}(x${String(entry.count)})`;
};

const blockers = (findings: readonly FindingDto[]): string[] =>
  findings.filter((entry) => entry.severity === 'blocker').map(describe);

export interface SummaryOptions {
  /** Only the verdict and the counts. */
  brief?: boolean;
  /** At most this many incomplete items are listed. */
  maxItems?: number;
}

export function formatSummary(report: ContentReadinessDto, options: SummaryOptions = {}): string {
  const { totals } = report;
  const lines: string[] = [];
  lines.push(
    `Content readiness: ${String(totals.liveReady)} of ${String(report.expectedActive)} live products ready` +
      ` (live ${String(totals.live)}, active ${String(totals.active)}, drafts ${String(totals.drafts)})`,
  );
  lines.push(
    `Categories ready: ${String(totals.categoriesReady)} of ${String(totals.categories)}; photos with problems: ${String(totals.photosWithProblems)} of ${String(totals.photos)}`,
  );
  for (const check of report.acceptance) {
    lines.push(
      `  [${check.ok ? 'ok' : 'FAIL'}] ${check.id}: ${String(check.actual)} (expected ${check.id === 'active_products' ? '>= ' : ''}${String(check.expected)})`,
    );
  }
  lines.push(`GATE: ${report.gatePassed ? 'PASS' : 'FAIL'}`);
  if (options.brief === true) return `${lines.join('\n')}\n`;

  const max = options.maxItems ?? 50;
  const incomplete = report.products.filter((row) => !row.ready && row.isActive);
  if (incomplete.length > 0) lines.push('', 'Active products with blockers:');
  for (const row of incomplete.slice(0, max))
    lines.push(`  ${plain(row.sku)} ${plain(row.slug)}: ${blockers(row.findings).join(', ')}`);
  if (incomplete.length > max) lines.push(`  ... and ${String(incomplete.length - max)} more`);

  const badCategories = report.categories.filter((row) => row.isActive && !row.ready);
  if (badCategories.length > 0) lines.push('', 'Categories with blockers:');
  for (const row of badCategories.slice(0, max))
    lines.push(`  ${plain(row.slug)}: ${blockers(row.findings).join(', ')}`);
  if (report.productsTruncated) lines.push('', 'Note: the product list was truncated.');
  return `${lines.join('\n')}\n`;
}
