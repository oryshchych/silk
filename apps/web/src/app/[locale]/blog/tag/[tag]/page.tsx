import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { BLOG_MAX_PAGE, isBlogTag } from '@store/shared/blog';
import { buildAlternates } from '@store/shared/seo';

import { BlogList } from '@/components/blog-list';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { getCachedPosts, getCachedTags } from '@/lib/blog';
import { pageMetadata } from '@/lib/metadata';
import { paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

type Props = PageProps<'/[locale]/blog/tag/[tag]'>;

const pageSchema = z.coerce.number().int().min(1).max(BLOG_MAX_PAGE).catch(1);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale: segment, tag } = await params;
  const { locale, known } = resolveLocale(segment);
  if (!known || !isBlogTag(tag)) return {};
  const t = await getTranslations({ locale, namespace: 'blog' });
  const meta = await getTranslations({ locale, namespace: 'meta' });
  return pageMetadata({
    title: `${t('tagTitle', { tag })} | ${meta('siteName')}`,
    description: null,
    locale,
    siteName: meta('siteName'),
    alternates: buildAlternates({ siteUrl: await getSiteUrl(), locale, path: paths.blogTag(tag) }),
    // A tag page is a list of posts that are indexed on their own: followed, not indexed.
    index: false,
  });
}

/** A tag page. The tag is checked by the proxy gate against the tags in use before this renders; the page checks again. */
export default async function BlogTagPage({ params, searchParams }: Props) {
  const { locale: segment, tag } = await params;
  const { locale, known } = resolveLocale(segment);
  if (!known || !isBlogTag(tag)) notFound();
  const raw = (await searchParams)['page'];
  const page = pageSchema.parse(typeof raw === 'string' ? raw : undefined);
  const [posts, tags] = await Promise.all([
    getCachedPosts(locale, tag, page),
    getCachedTags(locale),
  ]);
  if (posts.total === 0) notFound();
  const t = await getTranslations('blog');
  return (
    <SiteShell locale={locale} path={paths.blogTag(tag)} degrade>
      <h1 className="font-display text-3xl">{t('tagTitle', { tag })}</h1>
      <p className="mb-6 mt-2">
        <a
          href={locale === 'en' ? '/en/blog' : '/blog'}
          className="inline-flex min-h-6 items-center underline"
        >
          {t('allPosts')}
        </a>
      </p>
      <BlogList
        locale={locale}
        posts={posts}
        tags={tags}
        basePath={paths.blogTag(tag)}
        labels={{
          empty: t('empty'),
          tags: t('tags'),
          prev: t('prev'),
          next: t('next'),
          pages: t('pages'),
        }}
      />
    </SiteShell>
  );
}
