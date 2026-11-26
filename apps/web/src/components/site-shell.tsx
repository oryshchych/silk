import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';

import type { SiteLocale } from '@store/shared/seo';

import { CartLink } from '@/components/cart-link';
import { CookieSettingsButton } from '@/components/cookie-settings-button';
import { getAnalyticsConfig } from '@/lib/analytics-config';
import { loadCategoryTree } from '@/lib/navigation';
import { href, paths } from '@/lib/paths';

const OTHER = { uk: 'en', en: 'uk' } as const;

/**
 * Header, footer and the page frame. Server-only: the language switch is a
 * plain link built from the page's own path and query, so it keeps the page
 * and the filters without client JavaScript (and without making pages
 * dynamic through `useSearchParams`).
 */
export async function SiteShell({
  locale,
  path,
  search = '',
  degrade = false,
  children,
}: {
  locale: SiteLocale;
  /** Locale-less pathname of the current page. */
  path: string;
  /** Normalised query of the current page. */
  search?: string;
  /** Render without navigation if categories cannot load: only for pages that are never cached. */
  degrade?: boolean;
  children: ReactNode;
}) {
  const t = await getTranslations('nav');
  const brand = await getTranslations('meta');
  const tf = await getTranslations('footer');
  const tree = await loadCategoryTree(locale, { degrade });
  const other = OTHER[locale];
  const hasAnalytics = (await getAnalyticsConfig()) !== null;
  const navLink = 'inline-flex min-h-6 items-center rounded-sm hover:underline';

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:bg-surface focus:p-2"
      >
        {t('skip')}
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href={href(locale, paths.home)} className="font-display text-xl tracking-wide">
            {brand('siteName')}
          </Link>
          <nav aria-label={t('main')} className="order-last w-full md:order-none md:w-auto">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {tree.map((category) => (
                <li key={category.id}>
                  <Link href={href(locale, paths.category(category.slug))} className={navLink}>
                    {category.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <form
            action={href(locale, paths.search)}
            method="get"
            role="search"
            aria-label={t('search')}
            className="ml-auto flex items-center gap-2"
          >
            <label className="sr-only" htmlFor="site-search">
              {t('search')}
            </label>
            <input
              id="site-search"
              type="search"
              name="q"
              minLength={2}
              maxLength={100}
              placeholder={t('searchPlaceholder')}
              className="w-40 rounded-sm border border-border bg-surface px-2 py-1 text-sm md:w-56"
            />
            <button
              type="submit"
              className="min-h-8 rounded-full border border-border px-3 text-sm"
            >
              {t('searchSubmit')}
            </button>
          </form>
          <CartLink href={href(locale, paths.cart)} />
          <Link
            href={href(other, path, search)}
            hrefLang={other}
            lang={other}
            className="min-h-8 rounded-full border border-border px-3 py-1 text-sm hover:bg-surface-raised"
          >
            {t('switchTo')}
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6">
        {children}
      </main>
      <footer className="mt-12 border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-text-muted">
          <p>{tf('about')}</p>
          {hasAnalytics ? <CookieSettingsButton /> : null}
        </div>
      </footer>
    </>
  );
}
