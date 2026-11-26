import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { parseListingParams, serializeListingParams } from '@store/core/catalog';
import { buildBreadcrumbList, buildItemList } from '@store/shared/schema-org';
import { buildAlternates } from '@store/shared/seo';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { FiltersForm } from '@/components/filters-form';
import { JsonLd } from '@/components/json-ld';
import { Pagination } from '@/components/pagination';
import { ProductCard } from '@/components/product-card';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { getCachedFilterOptions, loadCategoryPage, loadListing } from '@/lib/catalog';
import { CATEGORY_CARD_SIZES } from '@/lib/image-sizes';
import { listingSeo } from '@/lib/listing-seo';
import { pageMetadata } from '@/lib/metadata';
import { href, paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

type Props = PageProps<'/[locale]/category/[slug]'>;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  const category = known ? await loadCategoryPage(slug, locale) : null;
  if (category === null) return {};

  const t = await getTranslations({ locale, namespace: 'meta' });
  const tl = await getTranslations({ locale, namespace: 'listing' });
  const parsedParams = parseListingParams(await searchParams);
  const seo = listingSeo(parsedParams);
  const name = category.page.name;
  // An indexable band filter is its own landing page: its own title and description.
  const band = seo.canonicalSearch === '' ? undefined : parsedParams.bands[0];
  const heading = band === undefined ? name : tl('bandTitle', { name, band });
  return pageMetadata({
    title: `${band === undefined ? (category.page.metaTitle ?? name) : heading} | ${t('siteName')}`,
    description:
      band === undefined
        ? (category.page.metaDescription ??
          category.page.description ??
          tl('metaDescription', { name }))
        : tl('bandDescription', { name, band }),
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

export default async function CategoryPage({ params, searchParams }: Props) {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  if (!known) notFound();

  // Existence is decided BEFORE anything streams, so a missing category is a real 404.
  const category = await loadCategoryPage(slug, locale);
  if (category === null) notFound();

  // Filter values are restricted to what the category offers before they can
  // become a cache key or a query (see loadListing).
  const options = await getCachedFilterOptions({ categoryIds: category.categoryIds, locale });
  const loaded = await loadListing({
    categoryIds: category.categoryIds,
    params: parseListingParams(await searchParams),
    options,
    locale,
  });
  if (loaded === null) notFound();
  const { listing, params: listingParams } = loaded;

  const t = await getTranslations('listing');
  const tn = await getTranslations('nav');
  const siteUrl = await getSiteUrl();
  const search = serializeListingParams(listingParams);
  const band =
    listingSeo(listingParams).canonicalSearch === '' ? undefined : listingParams.bands[0];
  const title =
    band === undefined ? category.page.name : t('bandTitle', { name: category.page.name, band });
  const pagePath = paths.category(slug);
  // The home URL has no trailing slash, so it equals the canonical of the home page.
  const absolute = (path: string): string => {
    const local = href(locale, path);
    return `${siteUrl}${local === '/' ? '' : local}`;
  };
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
      <h1 className="mt-3 font-display text-3xl">{title}</h1>
      {category.page.description === null ? null : (
        <p className="mt-2 max-w-2xl text-text-muted">{category.page.description}</p>
      )}
      <div className="mt-6 grid gap-8 md:grid-cols-[16rem_1fr]">
        <aside>
          <FiltersForm options={options} params={listingParams} />
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
                  <ProductCard
                    product={item}
                    locale={locale}
                    sizes={CATEGORY_CARD_SIZES}
                    priority={index === 0}
                    eager={index > 0 && index < 3}
                  />
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
