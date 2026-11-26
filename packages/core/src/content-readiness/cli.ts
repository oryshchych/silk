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

/** Words that name a production database, in the host, the database name or the user. */
const PRODUCTION_WORD = /(^|[^a-z0-9])(prod|production|prd|live)($|[^a-z0-9])/i;
/** Connection parameters that make the driver connect somewhere other than the URL's host. */
const REDIRECTING_PARAMS = ['host', 'hostaddr', 'service', 'options', 'sslrootcert'] as const;

/** Loopback, a `.local` / `.localhost` name, or a bare compose service name (no dot). */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (host !== '' && !host.includes('.') && !host.includes(':'))
  );
}

export interface TargetOptions {
  /** The caller said, on the command line, that a database that is not local is meant. */
  allowRemote: boolean;
}

/**
 * The checker only reads (the caller opens a read-only transaction), and on top of that it opens a
 * database only when the target is plainly NOT production:
 *  - the default is an ALLOWLIST: loopback, a `.local` name or a bare service name;
 *  - anything else (staging, a managed cloud host) needs `--allow-remote`, an explicit flag that is
 *    never inherited from the environment;
 *  - a name that says production (`prod`, `production`, `prd`, `live`) is refused even then;
 *  - `host`, `hostaddr`, `service` and `options` in the query string are refused: the driver would
 *    connect there instead of to the host the check just looked at.
 * A guard against a mistake, not a wall: the wall is the read-only transaction and keeping
 * production credentials off the machines where this runs (`docs/AI_SETUP.md`).
 */
export function assertSafeTarget(databaseUrl: string | undefined, options: TargetOptions): URL {
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
  for (const name of REDIRECTING_PARAMS)
    if (url.searchParams.has(name))
      throw new UnsafeTargetError(`the URL parameter "${name}" is not accepted`);
  const parts = [url.hostname, decodeURIComponent(url.pathname), decodeURIComponent(url.username)];
  if (parts.some((part) => PRODUCTION_WORD.test(part)))
    throw new UnsafeTargetError('the database looks like production');
  if (!isLocalHost(url.hostname) && !options.allowRemote)
    throw new UnsafeTargetError('the database is not local: pass --allow-remote if it is meant');
  return url;
}

/** Terminal-safe text: staff input must not carry escape sequences into a terminal or a log. */
export const plain = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');

const GLOSS: Record<string, string> = {
  inactive: 'draft, not active',
  unpublished: 'active but not published (no date, or in the future)',
  category_hidden: 'active but its category chain is hidden',
  slug_unservable: 'the slug cannot be served',
  noindex: 'marked noindex: excluded from search',
  brand_missing: 'brand missing',
  price_missing: 'price missing',
  no_active_variant: 'no active variant',
  no_stock: 'no active variant has stock',
  no_attributes: 'no attributes assigned',
  gtin_missing: 'variants without a valid GTIN',
  variant_sku_too_long: 'a variant SKU over the feed limit: the feed drops it',
  missing: 'missing',
  too_short: 'shorter than the guide asks',
  too_long: 'longer than the guide allows',
  same_in_both_languages: 'the same text in both languages',
  duplicate_in_catalog: 'the same text as another product',
  claim_review: 'wording that needs a source (certification, health claim)',
  no_photo: 'no photo',
  photo_alt_missing: 'photos without alt text',
  photo_alt_too_short: 'alt text too short to be real',
  photo_alt_too_long: 'alt text over the length bound',
  photo_too_narrow: 'photos narrower than the minimum',
  photo_aspect: 'photos outside the recommended proportions',
  photo_renditions_missing: 'photos with a missing rendition',
  photo_url_unsafe: 'photos with an unsafe address',
  no_products: 'an indexable category with no live products',
};

const describe = (entry: FindingDto): string => {
  const where = [entry.field, entry.locale === null ? null : entry.locale.toUpperCase()].filter(
    (part): part is string => part !== null,
  );
  const gloss = GLOSS[entry.code] ?? entry.code;
  const text = where.length === 0 ? gloss : `${where.join(' ')}: ${gloss}`;
  return entry.count === null ? text : `${text} (${String(entry.count)})`;
};

const bySeverity = (findings: readonly FindingDto[], severity: FindingDto['severity']): string[] =>
  findings.filter((entry) => entry.severity === severity).map(describe);

export interface SummaryOptions {
  /** Only the verdict and the counts. */
  brief?: boolean;
  /** At most this many incomplete items are listed. */
  maxItems?: number;
  /** The target came from the default, not from the command line. */
  defaultTarget?: boolean;
}

export function formatSummary(report: ContentReadinessDto, options: SummaryOptions = {}): string {
  const { totals } = report;
  const lines: string[] = [];
  lines.push(
    `Content readiness: ${String(totals.liveReady)} of ${String(report.expectedActive)} live products ready` +
      ` (live ${String(totals.live)}, active ${String(totals.active)}, drafts ${String(totals.drafts)})` +
      (options.defaultTarget === true
        ? ` [target ${String(report.expectedActive)} is the default; set --expected-active=N]`
        : ''),
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
    lines.push(
      `  ${plain(row.sku)} ${plain(row.slug)}: ${bySeverity(row.findings, 'blocker').join('; ')}`,
    );
  if (incomplete.length > max) lines.push(`  ... and ${String(incomplete.length - max)} more`);

  const badCategories = report.categories.filter((row) => row.isActive && !row.ready);
  if (badCategories.length > 0) lines.push('', 'Categories with blockers:');
  for (const row of badCategories.slice(0, max))
    lines.push(`  ${plain(row.slug)}: ${bySeverity(row.findings, 'blocker').join('; ')}`);

  // Advice never fails the gate, but it is what makes the text good: count per kind, then a few examples.
  const advice = new Map<string, number>();
  for (const row of [...report.products.filter((p) => p.isActive), ...report.categories]) {
    for (const entry of row.findings) {
      if (entry.severity === 'warning') {
        const key = describe({ ...entry, count: null });
        advice.set(key, (advice.get(key) ?? 0) + 1);
      }
    }
  }
  if (advice.size > 0) lines.push('', 'Advice (does not fail the gate):');
  for (const [text, count] of [...advice].sort((a, b) => b[1] - a[1]).slice(0, max))
    lines.push(`  ${String(count)} x ${text}`);
  if (report.productsTruncated) lines.push('', 'Note: the product list was truncated.');
  return `${lines.join('\n')}\n`;
}
