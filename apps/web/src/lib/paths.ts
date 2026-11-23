import { localizedPath, type SiteLocale } from '@store/shared/seo';

/** Locale-less storefront paths; `href` adds the locale prefix. */
export const paths = {
  home: '/',
  category: (slug: string): string => `/category/${slug}`,
  product: (slug: string): string => `/product/${slug}`,
  search: '/search',
} as const;

export const href = (locale: SiteLocale, path: string, search = ''): string =>
  `${localizedPath(locale, path)}${search === '' ? '' : `?${search}`}`;
