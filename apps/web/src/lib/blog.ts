/**
 * Cached public reads of the blog (ADR-8). Cache KEYS are built from the locale, a tag or a slug that the proxy gate
 * already checked against the set of real ones (an unknown word never reaches here), and a page number clamped to
 * `BLOG_MAX_PAGE`: nothing a client can freely choose becomes an unbounded key. Tags: `blog` for lists, `blog:{slug}` for one
 * post. "Visible" is the database clock's decision, so a TTL is also what lets a scheduled post go live.
 */
import { unstable_cache } from 'next/cache';

import { getPublishedPost, listPublishedPosts, listPublishedTags } from '@store/core/blog';
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

export const getCachedPosts = (locale: SiteLocale, tag: string | undefined, page: number) =>
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
