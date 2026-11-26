/**
 * Sitemap XML builders (sitemaps.org plus xhtml:link alternates). Pure strings, no framework: the
 * values come from the database, so EVERY text value goes through `escapeXml`, and the lastmod is
 * checked to be a W3C date-time before it is written.
 */
import { buildAlternates, siteLocales, type SiteLocale } from './seo';

/** A sitemap file holds at most 50 000 URLs AND 50 MB uncompressed; a product takes one URL per locale. */
export const SITEMAP_URL_LIMIT = 50_000;
export const SITEMAP_BYTE_LIMIT = 50 * 1024 * 1024;
/**
 * Products per file. A URL entry repeats its slug four times, and a slug may be 200 characters,
 * so the byte limit (not the URL limit) decides: 15 000 products stay near 36 MB even then.
 */
export const SITEMAP_PRODUCTS_PER_FILE = 15_000;

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const LASTMOD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const URLSET_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
export const URLSET_CLOSE = '</urlset>\n';

export interface SitemapEntry {
  /** Locale-less path, already percent-encoded (`slugPath` does it for a slug), e.g. `/category/bras`. */
  path: string;
  /** UTC date-time (`2026-11-26T10:00:00Z`); omitted when unknown or malformed. */
  lastmod: string | null;
}

/** The home page is written without the trailing slash, exactly as its canonical is rendered. */
const bare = (url: string): string => (url.endsWith('/') ? url.slice(0, -1) : url);

/** One `<url>` per locale, each listing the whole pair (hreflang from the single source). */
/** A storefront path with the slug percent-encoded: a slug can never change the shape of the URL. */
export const slugPath = (kind: 'product' | 'category', slug: string): string =>
  `/${kind}/${encodeURIComponent(slug)}`;

export function urlEntries(siteUrl: string, entry: SitemapEntry): string {
  const lastmod =
    entry.lastmod !== null && LASTMOD.test(entry.lastmod)
      ? `<lastmod>${entry.lastmod}</lastmod>`
      : '';
  return siteLocales
    .map((locale: SiteLocale) => {
      const alternates = buildAlternates({ siteUrl, locale, path: entry.path });
      const links = (['uk', 'en', 'x-default'] as const)
        .map(
          (lang) =>
            `<xhtml:link rel="alternate" hreflang="${lang}" href="${escapeXml(bare(alternates.languages[lang]))}"/>`,
        )
        .join('');
      return `<url><loc>${escapeXml(bare(alternates.canonical))}</loc>${lastmod}${links}</url>\n`;
    })
    .join('');
}

export function sitemapIndexXml(locs: readonly string[]): string {
  const items = locs.map((loc) => `<sitemap><loc>${escapeXml(loc)}</loc></sitemap>\n`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}</sitemapindex>\n`
  );
}

/** The only slug spelling the storefront serves (the proxy gate uses the same shape). */
export const SITEMAP_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Syntax only: `pages.xml` or `products-<n>.xml`. No database, so a bad name costs nothing. */
export function isSitemapFileName(name: string): boolean {
  return name === 'pages.xml' || /^products-(?:0|[1-9]\d{0,5})\.xml$/.test(name);
}

/** `pages.xml` or `products-<n>.xml` (n below `fileCount`): anything else is not a sitemap. */
export type SitemapName = { kind: 'pages' } | { kind: 'products'; index: number };

export function parseSitemapName(name: string, productFiles: number): SitemapName | null {
  if (name === 'pages.xml') return { kind: 'pages' };
  const match = /^products-(0|[1-9]\d{0,5})\.xml$/.exec(name);
  if (match?.[1] === undefined) return null;
  const index = Number(match[1]);
  return index < productFiles ? { kind: 'products', index } : null;
}

export const productFileCount = (products: number): number =>
  Math.max(1, Math.ceil(products / SITEMAP_PRODUCTS_PER_FILE));
