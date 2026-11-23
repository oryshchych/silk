/**
 * Listing state lives in the URL (ADR-7): parse it, normalise it, write it
 * back. Pure and framework-free, so the same code serves the page, the
 * language switcher and (phase 6) the canonical rules.
 *
 * Invalid values are dropped, never rejected: a hand-edited or stale URL
 * still renders a page, and it normalises to one canonical query string.
 */
import { parseHryvnias } from '@store/shared/money';

export const SORT_KEYS = ['newest', 'price_asc', 'price_desc', 'discount'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const PAGE_SIZE = 24;
const MAX_VALUES = 20;
export const MAX_PAGE = 1000;
const MAX_PRICE_KOPIYKAS = 100_000_000;

/**
 * Bounds (value counts, lengths, band range, price cap) are enforced ONLY in
 * `parseListingParams`. Anything that builds a `ListingParams` by hand must
 * respect them; `listProducts` clamps just the page number.
 */
const parsed: unique symbol = Symbol('parsed-listing-params');

export interface ListingParams {
  /** Brand: only `parseListingParams` (or `restrictListingParams` on its result) can produce a value. */
  readonly [parsed]: true;
  bands: number[];
  cups: string[];
  /** Labels of panty / apparel sizes (`M`, `XL`). */
  sizes: string[];
  colors: string[];
  brands: string[];
  /** Kopiykas. */
  priceMin: number | null;
  priceMax: number | null;
  inStock: boolean;
  onSale: boolean;
  sort: SortKey;
  page: number;
}

export type RawSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Object literal of the fields, then branded: this file is the only place that may do it. */
const brandParams = (fields: Omit<ListingParams, typeof parsed>): ListingParams => ({
  ...fields,
  [parsed]: true,
});

export const defaultListingParams: ListingParams = brandParams({
  bands: [],
  cups: [],
  sizes: [],
  colors: [],
  brands: [],
  priceMin: null,
  priceMax: null,
  inStock: false,
  onSale: false,
  sort: 'newest',
  page: 1,
});

/** `a=1&a=2` and `a=1,2` both mean two values. */
function values(raw: RawSearchParams, key: string): string[] {
  const value = raw[key];
  const list = value === undefined ? [] : typeof value === 'string' ? [value] : [...value];
  return list
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

const unique = <T>(items: T[]): T[] => [...new Set(items)].slice(0, MAX_VALUES);

function matching(raw: RawSearchParams, key: string, pattern: RegExp): string[] {
  return unique(values(raw, key).filter((item) => pattern.test(item))).sort();
}

function bands(raw: RawSearchParams): number[] {
  return unique(
    values(raw, 'band')
      .filter((item) => /^\d{2,3}$/.test(item))
      .map(Number)
      .filter((band) => band >= 60 && band <= 110 && band % 5 === 0),
  ).sort((a, b) => a - b);
}

function price(raw: RawSearchParams, key: string): number | null {
  const [first] = values(raw, key);
  if (first === undefined || !/^\d{1,7}$/.test(first)) return null;
  const kopiykas = parseHryvnias(first);
  return kopiykas > MAX_PRICE_KOPIYKAS ? null : kopiykas;
}

function flag(raw: RawSearchParams, key: string): boolean {
  return values(raw, key).includes('1');
}

/** Page number as a safe OFFSET base: an integer from 1 to MAX_PAGE. */
export function clampPage(page: number): number {
  return Number.isInteger(page) ? Math.min(Math.max(page, 1), MAX_PAGE) : 1;
}

export function parseListingParams(raw: RawSearchParams): ListingParams {
  const [sort] = values(raw, 'sort');
  const [page] = values(raw, 'page');
  let priceMin = price(raw, 'price_min');
  let priceMax = price(raw, 'price_max');
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    [priceMin, priceMax] = [priceMax, priceMin];
  }
  const pageNumber = page !== undefined && /^\d{1,4}$/.test(page) ? Number(page) : 1;
  return brandParams({
    bands: bands(raw),
    cups: matching(raw, 'cup', /^[A-Z]{1,3}$/),
    sizes: matching(raw, 'size', /^[A-Za-z0-9 -]{1,20}$/),
    colors: matching(raw, 'color', /^[a-z0-9-]{1,80}$/),
    brands: unique(values(raw, 'brand').filter((item) => item.length <= 120)).sort(),
    priceMin,
    priceMax,
    inStock: flag(raw, 'in_stock'),
    onSale: flag(raw, 'sale'),
    sort: SORT_KEYS.find((key) => key === sort) ?? 'newest',
    page: clampPage(pageNumber),
  });
}

/** What a category actually offers; the shape of `FilterOptionsDto` that matters here. */
export interface KnownFilterValues {
  bands: readonly number[];
  cups: readonly string[];
  sizes: readonly { label: string }[];
  colors: readonly { slug: string }[];
  brands: readonly string[];
}

/**
 * Drops filter values the category does not offer. A value that matches
 * nothing can only produce an empty page, but it would still become a cache
 * key and a database query, and a client can invent unlimited values. Run it
 * before the params reach a cache or SQL.
 */
export function restrictListingParams(
  params: ListingParams,
  known: KnownFilterValues,
): ListingParams {
  return {
    ...params,
    bands: params.bands.filter((band) => known.bands.includes(band)),
    cups: params.cups.filter((cup) => known.cups.includes(cup)),
    sizes: params.sizes.filter((size) => known.sizes.some((option) => option.label === size)),
    colors: params.colors.filter((color) => known.colors.some((option) => option.slug === color)),
    brands: params.brands.filter((brand) => known.brands.includes(brand)),
  };
}

const hryvnias = (kopiykas: number): string => String(Math.floor(kopiykas / 100));

/**
 * Stable query string without defaults, e.g. `band=75&cup=B&color=black`.
 * The same params always give the same string, whatever order they came in.
 */
export function serializeListingParams(params: ListingParams): string {
  const parts: [string, string][] = [];
  if (params.bands.length > 0) parts.push(['band', params.bands.join(',')]);
  if (params.cups.length > 0) parts.push(['cup', params.cups.join(',')]);
  if (params.sizes.length > 0) parts.push(['size', params.sizes.join(',')]);
  if (params.colors.length > 0) parts.push(['color', params.colors.join(',')]);
  if (params.brands.length > 0) parts.push(['brand', params.brands.join(',')]);
  if (params.priceMin !== null) parts.push(['price_min', hryvnias(params.priceMin)]);
  if (params.priceMax !== null) parts.push(['price_max', hryvnias(params.priceMax)]);
  if (params.inStock) parts.push(['in_stock', '1']);
  if (params.onSale) parts.push(['sale', '1']);
  if (params.sort !== 'newest') parts.push(['sort', params.sort]);
  if (params.page > 1) parts.push(['page', String(params.page)]);
  return parts
    .map(([key, value]) => `${key}=${encodeURIComponent(value).replaceAll('%2C', ',')}`)
    .join('&');
}
