import type { MetadataRoute } from 'next';

import { siteLocales, localizedPath } from '@store/shared/seo';

/** Routes with nothing to index, in every locale. Facets are NOT here: they carry `noindex, follow`, which a crawler must be able to read. */
/**
 * Roots of the routes with nothing to index. Each closes the page itself (`$`), what is under it
 * (`/`) and its query forms (`?`), but not a sibling that merely starts the same (`/cartier`).
 * `/order/` already carries the slash. Facets are NOT here: they carry `noindex, follow`, which
 * a crawler must be able to read.
 */
const PRIVATE_ROOTS = ['/cart', '/checkout', '/search'] as const;
const PRIVATE = [
  ...PRIVATE_ROOTS.flatMap((root) => [`${root}$`, `${root}/`, `${root}?`]),
  '/order/',
] as const;

export function robotsRules(appEnv: string, siteUrl: string): MetadataRoute.Robots {
  if (appEnv !== 'production') return { rules: { userAgent: '*', disallow: '/' } };
  const disallow = [
    '/admin/',
    '/api/',
    ...siteLocales.flatMap((locale) => PRIVATE.map((path) => localizedPath(locale, path))),
  ];
  return {
    rules: { userAgent: '*', allow: '/', disallow },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
