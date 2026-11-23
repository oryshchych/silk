import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { parseListingParams, serializeListingParams } from '@store/core/catalog';
import { buildBreadcrumbList, buildItemList } from '@store/shared/schema-org';
import { buildAlternates } from '@store/shared/seo';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { FiltersForm } from '@/components/filters-form';
import { FiltersSkeleton } from '@/components/filters-skeleton';
import { JsonLd } from '@/components/json-ld';
import { Pagination } from '@/components/pagination';
import { ProductCard } from '@/components/product-card';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { getCachedCategoryPage, getCachedFilterOptions, getCachedListing } from '@/lib/catalog';
import { listingSeo } from '@/lib/listing-seo';
import { pageMetadata } from '@/lib/metadata';
import { href, paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

type Props = PageProps<'/[locale]/category/[slug]'>;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  const category = known ? await getCachedCategoryPage(slug, locale) : null;
  if (category === null) return {};

  const t = await getTranslations({ locale, namespace: 'meta' });
  const tl = await getTranslations({ locale, namespace: 'listing' });
  const seo = listingSeo(parseListingParams(await searchParams));
  const name = category.page.name;
  return pageMetadata({
    title: `${category.page.metaTitle ?? name} | ${t('siteName')}`,
    description:
      category.page.metaDescription ?? category.page.description ?? tl('metaDescription', { name }),
    locale,
    siteName: t('siteName'),
    alternates: buildAlternates({
      siteUrl: await getSiteUrl(),
      locale,
      path: paths.category(slug),
      search: seo.canonicalSearch,
    }),
    index: seo.index && !category.page.noindex,
    image: category.page.imageUrl,
  });
}

async function FiltersPanel({
  categoryIds,
  locale,
  params,
}: {
  categoryIds: readonly string[];
  locale: 'uk' | 'en';
  params: ReturnType<typeof parseListingParams>;
}) {
  const options = await getCachedFilterOptions({ categoryIds, locale });
  return <FiltersForm options={options} params={params} />;
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  if (!known) notFound();

  // Existence is decided BEFORE anything streams, so a missing category is a real 404.
  const category = await getCachedCategoryPage(slug, locale);
  if (category === null) notFound();

  const listingParams = parseListingParams(await searchParams);
  const listing = await getCachedListing({
    categoryIds: category.categoryIds,
    params: listingParams,
    locale,
  });
  if (listingParams.page > Math.max(listing.totalPages, 1)) notFound();

  const t = await getTranslations('listing');
  const tn = await getTranslations('nav');
  const siteUrl = await getSiteUrl();
  const search = serializeListingParams(listingParams);
  const pagePath = paths.category(slug);
  const absolute = (path: string): string => `${siteUrl}${href(locale, path)}`;
  const trail = category.page.breadcrumbs;
  const hrefForPage = (page: number): string =>
    href(locale, pagePath, serializeListingParams({ ...listingParams, page }));

  return (
    <SiteShell locale={locale} path={pagePath} search={search}>
      <JsonLd
        data={buildBreadcrumbList([
          { name: tn('home'), url: absolute(paths.home) },
          ...trail.map((crumb) => ({
            name: crumb.name,
            url: absolute(paths.category(crumb.slug)),
          })),
        ])}
      />
      <JsonLd
        data={buildItemList(
          listing.items.map((item) => ({
            name: item.name,
            url: absolute(paths.product(item.slug)),
          })),
          (listing.page - 1) * listing.limit + 1,
        )}
      />
      <Breadcrumbs
        locale={locale}
        crumbs={[
          { name: tn('home'), path: paths.home },
          ...trail.map((crumb, index) => ({
            name: crumb.name,
            ...(index === trail.length - 1 ? {} : { path: paths.category(crumb.slug) }),
          })),
        ]}
      />
      <h1 className="mt-3 font-display text-3xl">{category.page.name}</h1>
      {category.page.description === null ? null : (
        <p className="mt-2 max-w-2xl text-text-muted">{category.page.description}</p>
      )}
      <div className="mt-6 grid gap-8 md:grid-cols-[16rem_1fr]">
        <aside>
          <Suspense fallback={<FiltersSkeleton />}>
            <FiltersPanel
              categoryIds={category.categoryIds}
              locale={locale}
              params={listingParams}
            />
          </Suspense>
        </aside>
        <section aria-label={t('title')} className="flex flex-col gap-6">
          <p aria-live="polite" className="text-sm text-text-muted">
            {t('results', { count: listing.total })}
          </p>
          {listing.items.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-8">
              <h2 className="font-display text-2xl">{t('emptyTitle')}</h2>
              <p className="text-text-muted">{t('emptyText')}</p>
              <Link
                href={href(locale, pagePath)}
                className="min-h-10 rounded-full border border-border px-5 py-2 hover:bg-surface-raised"
              >
                {t('resetFilters')}
              </Link>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-3">
              {listing.items.map((item, index) => (
                <li key={item.id}>
                  <ProductCard product={item} locale={locale} priority={index < 3} />
                </li>
              ))}
            </ul>
          )}
          <Pagination current={listing.page} total={listing.totalPages} hrefFor={hrefForPage} />
        </section>
      </div>
    </SiteShell>
  );
}
