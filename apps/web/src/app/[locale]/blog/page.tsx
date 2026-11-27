import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { BLOG_MAX_PAGE } from '@store/shared/blog';
import { buildAlternates } from '@store/shared/seo';

import { BlogList } from '@/components/blog-list';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { getCachedPosts, getCachedTags } from '@/lib/blog';
import { pageMetadata } from '@/lib/metadata';
import { paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

type Props = PageProps<'/[locale]/blog'>;

const pageSchema = z.coerce.number().int().min(1).max(BLOG_MAX_PAGE).catch(1);

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'blog' });
  const meta = await getTranslations({ locale, namespace: 'meta' });
  const raw = (await searchParams)['page'];
  const page = pageSchema.parse(typeof raw === 'string' ? raw : undefined);
  return pageMetadata({
    title: `${t('title')} | ${meta('siteName')}`,
    description: t('description'),
    locale,
    siteName: meta('siteName'),
    alternates: buildAlternates({ siteUrl: await getSiteUrl(), locale, path: paths.blog }),
    // The first page only is indexed: the rest are lists of lists.
    index: page === 1,
  });
}

/** The blog index. Dynamic (the page number is in the query); the data comes from the data cache, the same for everybody. */
export default async function BlogIndexPage({ params, searchParams }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const raw = (await searchParams)['page'];
  const page = pageSchema.parse(typeof raw === 'string' ? raw : undefined);
  const [posts, tags] = await Promise.all([
    getCachedPosts(locale, undefined, page),
    getCachedTags(locale),
  ]);
  const t = await getTranslations('blog');
  return (
    <SiteShell locale={locale} path={paths.blog} degrade>
      <h1 className="font-display text-3xl">{t('title')}</h1>
      <p className="mb-6 mt-2 max-w-2xl text-text-muted">{t('intro')}</p>
      <BlogList
        locale={locale}
        posts={posts}
        tags={tags}
        basePath={paths.blog}
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
