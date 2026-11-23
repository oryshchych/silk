/**
 * Cached public catalog reads (ADR-8). Drizzle queries are not cached by
 * anything, so each read is wrapped explicitly: the key carries locale and
 * parameters, the tags are `category:{id}` / `product:{id}` / `categories`,
 * and a TTL is the safety net for a missed invalidation.
 */
import { unstable_cache } from 'next/cache';

import {
  getCategories,
  getCategoryPage,
  getFilterOptions,
  listProducts,
  listShowcase,
  normalizeListingParams,
  restrictListingParams,
  type ListingParams,
  type ShowcaseKind,
} from '@store/core/catalog';
import { categoryTag, CATEGORIES_TAG, SHOWCASE_TAG } from '@store/shared/cache-tags';
import type { FilterOptionsDto, ListingDto } from '@store/shared/dto/catalog';
import type { SiteLocale } from '@store/shared/seo';

import { getDb } from './db';
import { errorReason } from './error-reason';
import { isCacheableListing } from './listing-cache-policy';

const CATEGORY_TTL = 60 * 60;
const LISTING_TTL = 5 * 60;

export const getCachedCategories = (locale: SiteLocale) =>
  unstable_cache(async () => await getCategories(await getDb(), locale), ['categories', locale], {
    tags: [CATEGORIES_TAG],
    revalidate: CATEGORY_TTL,
  })();

const getCachedCategoryPage = (slug: string, locale: SiteLocale) =>
  unstable_cache(
    async () => await getCategoryPage(await getDb(), slug, locale),
    ['category-page', slug, locale],
    { tags: [CATEGORIES_TAG], revalidate: CATEGORY_TTL },
  )();

/**
 * Category page data for a slug. The slug is checked against the cached
 * category list FIRST: a cache key per client-chosen slug (misses included)
 * would grow without bound.
 */
export async function loadCategoryPage(slug: string, locale: SiteLocale) {
  const known = (await getCachedCategories(locale)).some((category) => category.slug === slug);
  return known ? await getCachedCategoryPage(slug, locale) : null;
}

/** Tagged with every category in scope, so changing a product refreshes its category and the ancestors listing it. */
const getCachedListing = (input: {
  categoryIds: readonly string[];
  params: ListingParams;
  locale: SiteLocale;
}) =>
  unstable_cache(
    async () => await listProducts(await getDb(), input),
    ['listing', input.locale, JSON.stringify(input.params), ...input.categoryIds],
    { tags: input.categoryIds.map(categoryTag), revalidate: LISTING_TTL },
  )();

export const getCachedFilterOptions = (input: {
  categoryIds: readonly string[];
  locale: SiteLocale;
}) =>
  unstable_cache(
    async () => await getFilterOptions(await getDb(), input),
    ['filter-options', input.locale, ...input.categoryIds],
    { tags: input.categoryIds.map(categoryTag), revalidate: LISTING_TTL },
  )();

export interface LoadedListing {
  listing: ListingDto;
  /** The filters actually applied: values the category does not offer are dropped. */
  params: ListingParams;
}

/**
 * Listing for a category page. Everything that reaches a cache key or SQL is
 * bounded: the caller's params are re-read through the URL grammar (a spread
 * keeps the type brand but not the bounds), filter values are restricted to
 * what the category offers, listings with a price range or many selected values
 * are not cached (`isCacheableListing`), and a page past the end is rejected
 * from the cached first page before its own key exists. Returns null for a
 * page past the end.
 */
export async function loadListing(input: {
  categoryIds: readonly string[];
  params: ListingParams;
  options: FilterOptionsDto;
  locale: SiteLocale;
}): Promise<LoadedListing | null> {
  const { categoryIds, locale } = input;
  const params = restrictListingParams(normalizeListingParams(input.params), input.options);

  if (!isCacheableListing(params)) {
    const listing = await listProducts(await getDb(), { categoryIds, params, locale });
    return params.page > Math.max(listing.totalPages, 1) ? null : { listing, params };
  }

  const first = await getCachedListing({ categoryIds, params: { ...params, page: 1 }, locale });
  if (params.page === 1) return { listing: first, params };
  if (params.page > Math.max(first.totalPages, 1)) return null;
  return { listing: await getCachedListing({ categoryIds, params, locale }), params };
}

const SHOWCASE_SIZE = 8;

const getCachedShowcase = (kind: ShowcaseKind, locale: SiteLocale) =>
  unstable_cache(
    async () => await listShowcase(await getDb(), { kind, limit: SHOWCASE_SIZE, locale }),
    ['showcase', kind, locale],
    { tags: [SHOWCASE_TAG], revalidate: LISTING_TTL },
  )();

/**
 * A home page showcase. The kind is a closed set, so its cache key is bounded.
 * The home page is rendered per request and must not fail because a showcase
 * could not load: it renders without that section and logs one safe line.
 */
export async function loadShowcase(kind: ShowcaseKind, locale: SiteLocale) {
  try {
    return await getCachedShowcase(kind, locale);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', scope: 'showcase', kind, reason: errorReason(error) })}\n`,
    );
    return [];
  }
}
