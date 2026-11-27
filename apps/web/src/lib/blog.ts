/**
 * Cached public reads of the blog (ADR-8). Cache KEYS are built from the locale, a tag or a slug that the proxy gate
 * already checked against the set of real ones (an unknown word never reaches here), and a page number clamped to
 * `BLOG_MAX_PAGE`: nothing a client can freely choose becomes an unbounded key. Tags: `blog` for lists, `blog:{slug}` for one
 * post. "Visible" is the database clock's decision, so a TTL is also what lets a scheduled post go live.
 */
import { unstable_cache } from 'next/cache';

import {
  countPublishedPosts,
  getPublishedPost,
  listPublishedPosts,
  listPublishedTags,
} from '@store/core/blog';
import { BLOG_TAG, blogPostTag } from '@store/shared/cache-tags';
import type { SiteLocale } from '@store/shared/seo';

import { getDb } from './db';

const TTL = 5 * 60;

export const getCachedPost = (slug: string, locale: SiteLocale) =>
  unstable_cache(
    async () => await getPublishedPost(await getDb(), slug, locale),
    ['blog-post', slug, locale],
    { tags: [blogPostTag(slug), BLOG_TAG], revalidate: TTL },
  )();

const getCachedCount = (locale: SiteLocale, tag: string | undefined) =>
  unstable_cache(
    async () => await countPublishedPosts(await getDb(), locale, tag),
    ['blog-count', locale, tag ?? ''],
    { tags: [BLOG_TAG], revalidate: TTL },
  )();

const getCachedPosts = (locale: SiteLocale, tag: string | undefined, page: number) =>
  unstable_cache(
    async () => await listPublishedPosts(await getDb(), locale, { tag, page }),
    ['blog-list', locale, tag ?? '', String(page)],
    { tags: [BLOG_TAG], revalidate: TTL },
  )();

export const getCachedTags = (locale: SiteLocale) =>
  unstable_cache(
    async () => await listPublishedTags(await getDb(), locale),
    ['blog-tags', locale],
    {
      tags: [BLOG_TAG],
      revalidate: TTL,
    },
  )();

export type BlogPageResult =
  { status: 'ok'; posts: Awaited<ReturnType<typeof getCachedPosts>> } | { status: 'missing' };

/**
 * One page of a list, for a page number a client chose. The (cached, one key per list) count is read FIRST: a page past
 * the last one is `missing` (a 404 for the caller) and never gets a cache key, so a sweep of `?page=1..200` creates at most
 * one entry per page that really exists. Page 1 always exists (an empty list is an honest page).
 */
export async function loadBlogPage(
  locale: SiteLocale,
  tag: string | undefined,
  page: number,
): Promise<BlogPageResult> {
  const { totalPages } = await getCachedCount(locale, tag);
  if (page > totalPages) return { status: 'missing' };
  return { status: 'ok', posts: await getCachedPosts(locale, tag, page) };
}

/** True when the tag is in use in BOTH languages: only then does a tag page have a counterpart (hreflang, language switch). */
export async function tagInBothLanguages(tag: string): Promise<boolean> {
  const [uk, en] = await Promise.all([getCachedTags('uk'), getCachedTags('en')]);
  return uk.some((entry) => entry.tag === tag) && en.some((entry) => entry.tag === tag);
}
