import type { MetadataRoute } from 'next';

import { siteLocales, localizedPath } from '@store/shared/seo';

/** Routes with nothing to index, in every locale. Facets are NOT here: they carry `noindex, follow`, which a crawler must be able to read. */
const PRIVATE = ['/cart', '/checkout', '/order/', '/search'] as const;

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
