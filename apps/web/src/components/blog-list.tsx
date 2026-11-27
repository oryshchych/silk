import Link from 'next/link';

import type { PublicPostCardDto } from '@store/shared/dto/blog';
import type { SiteLocale } from '@store/shared/seo';

import { href, paths } from '../lib/paths';

export interface BlogListProps {
  locale: SiteLocale;
  posts: { items: readonly PublicPostCardDto[]; page: number; totalPages: number };
  tags: readonly { tag: string; count: number }[];
  /** The locale-less path of this list, for the page links. */
  basePath: string;
  labels: { empty: string; tags: string; prev: string; next: string; pages: string };
}

const date = (iso: string, locale: SiteLocale): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Kyiv' }).format(
    new Date(iso),
  );

/** A list of post cards with the tag cloud and plain page links. Server markup, the same for every visitor. */
export function BlogList({ locale, posts, tags, basePath, labels }: BlogListProps) {
  return (
    <div className="flex flex-col gap-8">
      {tags.length === 0 ? null : (
        <nav aria-label={labels.tags}>
          <ul className="flex flex-wrap gap-2">
            {tags.map((entry) => (
              <li key={entry.tag}>
                <Link
                  href={href(locale, paths.blogTag(entry.tag))}
                  className="inline-flex min-h-6 items-center rounded-full border border-border px-3 text-sm hover:underline"
                >
                  {entry.tag}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {posts.items.length === 0 ? <p>{labels.empty}</p> : null}
      <ul className="flex max-w-3xl flex-col gap-6">
        {posts.items.map((post) => (
          <li key={post.slug}>
            <article>
              <h2 className="font-display text-2xl">
                <Link href={href(locale, paths.blogPost(post.slug))} className="hover:underline">
                  {post.title}
                </Link>
              </h2>
              <p className="text-sm text-text-muted">
                <time dateTime={post.publishedAt}>{date(post.publishedAt, locale)}</time>
              </p>
              {post.excerpt === null ? null : <p className="mt-1">{post.excerpt}</p>}
            </article>
          </li>
        ))}
      </ul>
      {posts.totalPages <= 1 ? null : (
        <nav aria-label={labels.pages} className="flex gap-4">
          {posts.page > 1 ? (
            <Link
              href={href(
                locale,
                basePath,
                posts.page - 1 === 1 ? '' : `page=${String(posts.page - 1)}`,
              )}
              className="inline-flex min-h-11 items-center underline"
            >
              {labels.prev}
            </Link>
          ) : null}
          <span className="inline-flex min-h-11 items-center">
            {posts.page} / {posts.totalPages}
          </span>
          {posts.page < posts.totalPages ? (
            <Link
              href={href(locale, basePath, `page=${String(posts.page + 1)}`)}
              className="inline-flex min-h-11 items-center underline"
            >
              {labels.next}
            </Link>
          ) : null}
        </nav>
      )}
    </div>
  );
}
