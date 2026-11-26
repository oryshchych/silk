import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH } from '@store/core/catalog';
import { buildAlternates } from '@store/shared/seo';

import { Pagination } from '@/components/pagination';
import { ProductCard } from '@/components/product-card';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { searchCatalog } from '@/lib/catalog';
import { LISTING_CARD_SIZES } from '@/lib/image-sizes';
import { pageMetadata } from '@/lib/metadata';
import { readSearchQuery } from '@/lib/search-query';
import { href, paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

type Props = PageProps<'/[locale]/search'>;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'search' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  const { query } = readSearchQuery(await searchParams);
  // Search results are not indexed; the canonical is the bare search page.
  return pageMetadata({
    title: `${query === '' ? t('title') : t('metaTitle', { query })} | ${tm('siteName')}`,
    description: null,
    locale,
    siteName: tm('siteName'),
    alternates: buildAlternates({ siteUrl: await getSiteUrl(), locale, path: paths.search }),
    index: false,
  });
}

export default async function SearchPage({ params, searchParams }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();

  const t = await getTranslations('search');
  const { query, page } = readSearchQuery(await searchParams);
  const searched = query.length >= MIN_QUERY_LENGTH;
  const results = searched ? await searchCatalog({ query, locale, page }) : null;
  // A page past the end is a real 404, decided before anything streams.
  if (results !== null && page > Math.max(results.totalPages, 1)) notFound();

  const search =
    query === '' ? '' : `q=${encodeURIComponent(query)}${page > 1 ? `&page=${String(page)}` : ''}`;
  const hrefForPage = (target: number): string =>
    href(
      locale,
      paths.search,
      `q=${encodeURIComponent(query)}${target > 1 ? `&page=${String(target)}` : ''}`,
    );

  return (
    <SiteShell locale={locale} path={paths.search} search={search}>
      <h1 className="font-display text-3xl">{t('heading')}</h1>
      <form
        action={href(locale, paths.search)}
        method="get"
        role="search"
        aria-label={t('label')}
        className="mt-4 flex max-w-xl gap-2"
      >
        <label className="sr-only" htmlFor="search-page-input">
          {t('label')}
        </label>
        <input
          id="search-page-input"
          type="search"
          name="q"
          defaultValue={query}
          minLength={MIN_QUERY_LENGTH}
          maxLength={MAX_QUERY_LENGTH}
          className="min-h-10 flex-1 rounded-sm border border-border bg-surface px-3"
        />
        <button type="submit" className="min-h-10 rounded-full bg-accent px-5 text-accent-contrast">
          {t('title')}
        </button>
      </form>

      {query === '' ? null : <p className="mt-4 text-text-muted">{t('resultsFor', { query })}</p>}
      {!searched && query !== '' ? (
        <p role="status" className="mt-2 text-sm text-text-muted">
          {t('tooShort', { min: MIN_QUERY_LENGTH })}
        </p>
      ) : null}

      {/* Always in the document, so a change of its text is announced. */}
      <p aria-live="polite" className="mt-4 text-sm text-text-muted">
        {results === null ? null : t('results', { count: results.total })}
      </p>
      {results === null ? null : (
        <section aria-label={t('heading')} className="mt-2 flex flex-col gap-6">
          {results.items.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-6">
              <h2 className="font-display text-2xl">{t('emptyTitle')}</h2>
              <p className="text-text-muted">{t('emptyText')}</p>
              <Link
                href={href(locale, paths.home)}
                className="min-h-10 rounded-full border border-border px-5 py-2 hover:bg-surface-raised"
              >
                {t('toCatalog')}
              </Link>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">
              {results.items.map((item, index) => (
                <li key={item.id}>
                  <ProductCard
                    product={item}
                    locale={locale}
                    sizes={LISTING_CARD_SIZES}
                    priority={index === 0}
                    eager={index > 0 && index < 4}
                  />
                </li>
              ))}
            </ul>
          )}
          <Pagination current={results.page} total={results.totalPages} hrefFor={hrefForPage} />
        </section>
      )}
    </SiteShell>
  );
}
