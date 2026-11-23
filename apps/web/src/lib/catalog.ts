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
  type ListingParams,
} from '@store/core/catalog';
import { categoryTag, CATEGORIES_TAG } from '@store/shared/cache-tags';
import type { SiteLocale } from '@store/shared/seo';

import { getDb } from './db';

const CATEGORY_TTL = 60 * 60;
const LISTING_TTL = 5 * 60;

export const getCachedCategories = (locale: SiteLocale) =>
  unstable_cache(async () => await getCategories(await getDb(), locale), ['categories', locale], {
    tags: [CATEGORIES_TAG],
    revalidate: CATEGORY_TTL,
  })();

export const getCachedCategoryPage = (slug: string, locale: SiteLocale) =>
  unstable_cache(
    async () => await getCategoryPage(await getDb(), slug, locale),
    ['category-page', slug, locale],
    { tags: [CATEGORIES_TAG], revalidate: CATEGORY_TTL },
  )();

/** Tagged with every category in scope, so changing a product refreshes its category and the ancestors listing it. */
export const getCachedListing = (input: {
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
