/**
 * Pure SEO helpers: site origin resolution and the single source of
 * canonical / hreflang URLs (RR6). No framework imports, so the rules are
 * unit-testable and reusable from the sitemap later (phase 6).
 */

export const siteLocales = ['uk', 'en'] as const;
export type SiteLocale = (typeof siteLocales)[number];
export const defaultSiteLocale: SiteLocale = 'uk';

const LOCAL_FALLBACK = 'http://localhost:3000';

export interface SiteUrlSources {
  /** Runtime value (ADR-10). Preferred. */
  SITE_URL?: string | undefined;
  /** Build-time value, kept only as a fallback for images built before SITE_URL existed. */
  NEXT_PUBLIC_SITE_URL?: string | undefined;
}

/** Origin without a trailing slash, e.g. `https://staging.damazla.com`. */
export function resolveSiteUrl(sources: SiteUrlSources): string {
  const raw = sources.SITE_URL ?? sources.NEXT_PUBLIC_SITE_URL ?? LOCAL_FALLBACK;
  return new URL(raw).origin;
}

/** Path of `path` (locale-less, starting with `/`) in `locale`. `uk` has no prefix. */
export function localizedPath(locale: SiteLocale, path: string): string {
  if (locale === defaultSiteLocale) return path;
  return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

export interface Alternates {
  canonical: string;
  languages: Record<SiteLocale | 'x-default', string>;
}

export interface AlternatesInput {
  siteUrl: string;
  locale: SiteLocale;
  /** Locale-less pathname, e.g. `/` or `/category/bras`. */
  path: string;
  /** Normalized query string without `?`, empty for none. Applied to every URL. */
  search?: string;
}

/**
 * The only place hreflang pairs are produced, so they are reciprocal by
 * construction. x-default points at the default-locale URL.
 */
export function buildAlternates(input: AlternatesInput): Alternates {
  const suffix = input.search === undefined || input.search === '' ? '' : `?${input.search}`;
  const url = (locale: SiteLocale): string =>
    `${input.siteUrl}${localizedPath(locale, input.path)}${suffix}`;
  return {
    canonical: url(input.locale),
    languages: { uk: url('uk'), en: url('en'), 'x-default': url(defaultSiteLocale) },
  };
}
