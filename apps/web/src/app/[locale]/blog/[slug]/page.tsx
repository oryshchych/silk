import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { descriptionFromHtml, isBlogSlug } from '@store/shared/blog';
import { buildArticle, buildBreadcrumbList } from '@store/shared/schema-org';
import { buildAlternates, type SiteLocale } from '@store/shared/seo';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { JsonLd } from '@/components/json-ld';
import { LegalBody } from '@/components/legal-body';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { getCachedPost } from '@/lib/blog';
import { pageMetadata } from '@/lib/metadata';
import { href, paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

type Props = PageProps<'/[locale]/blog/[slug]'>;

// ISR like the product and legal pages: the same page for every visitor. The proxy answers an unknown address with the
// 404 page before this route (nothing a client chooses may become a page cache entry), `blog:{slug}` and `blog` refresh it.
export const revalidate = 300;

export function generateStaticParams(): { locale: string; slug: string }[] {
  return [];
}

/** hreflang only when the post has a body in BOTH languages: never a pair with a missing counterpart. */
function alternatesOf(
  siteUrl: string,
  locale: SiteLocale,
  slug: string,
  locales: readonly string[],
) {
  const alternates = buildAlternates({ siteUrl, locale, path: paths.blogPost(slug) });
  return locales.length === 2 ? alternates : { canonical: alternates.canonical };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  if (!known || !isBlogSlug(slug)) return {};
  const post = await getCachedPost(slug, locale);
  if (post === null) return {};
  const meta = await getTranslations({ locale, namespace: 'meta' });
  return pageMetadata({
    title: `${post.metaTitle ?? post.title} | ${meta('siteName')}`,
    // Never the site-wide sentence on every post: the first paragraph when there is no excerpt or meta description.
    description: post.metaDescription ?? post.excerpt ?? descriptionFromHtml(post.bodyHtml),
    locale,
    siteName: meta('siteName'),
    alternates: alternatesOf(await getSiteUrl(), locale, slug, post.locales),
    hasCounterpart: post.locales.length === 2,
    article: { publishedTime: post.publishedAt, modifiedTime: post.updatedAt },
    index: true,
  });
}

export default async function BlogPostPage({ params }: Props) {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  if (!known || !isBlogSlug(slug)) notFound();
  const post = await getCachedPost(slug, locale);
  if (post === null) notFound();
  const t = await getTranslations('blog');
  const tn = await getTranslations('nav');
  const meta = await getTranslations('meta');
  const siteUrl = await getSiteUrl();
  const absolute = (path: string): string => {
    const local = href(locale, path);
    return `${siteUrl}${local === '/' ? '' : local}`;
  };
  const formatDate = (iso: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Kyiv' }).format(
      new Date(iso),
    );
  return (
    <SiteShell
      locale={locale}
      path={paths.blogPost(slug)}
      hasCounterpart={post.locales.length === 2}
    >
      <JsonLd
        data={buildBreadcrumbList([
          { name: tn('home'), url: absolute(paths.home) },
          { name: t('title'), url: absolute(paths.blog) },
          { name: post.title, url: absolute(paths.blogPost(slug)) },
        ])}
      />
      <JsonLd
        data={buildArticle({
          url: absolute(paths.blogPost(slug)),
          headline: post.title,
          description: post.metaDescription ?? post.excerpt,
          datePublished: post.publishedAt,
          dateModified: post.updatedAt,
          language: locale,
          author: post.author,
          publisherName: meta('siteName'),
          keywords: post.tags,
        })}
      />
      <Breadcrumbs
        locale={locale}
        crumbs={[
          { name: tn('home'), path: paths.home },
          { name: t('title'), path: paths.blog },
          { name: post.title },
        ]}
      />
      <article className="mt-3 flex max-w-3xl flex-col gap-4">
        <h1 className="font-display text-3xl">{post.title}</h1>
        <p className="text-sm text-text-muted">
          <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
          {post.author === null ? null : ` · ${t('by', { author: post.author })}`}
        </p>
        <LegalBody html={post.bodyHtml} />
        {post.tags.length === 0 ? null : (
          <ul aria-label={t('tags')} className="flex flex-wrap gap-2">
            {post.tags.map((tag) => (
              <li key={tag}>
                <Link
                  href={href(locale, paths.blogTag(tag))}
                  className="inline-flex min-h-6 items-center rounded-full border border-border px-3 text-sm hover:underline"
                >
                  {tag}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </article>
    </SiteShell>
  );
}
