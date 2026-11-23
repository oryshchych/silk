export interface ProductPath {
  locale: 'uk' | 'en';
  slug: string;
}

/** `/product/{slug}` and `/en/product/{slug}`; the slug is whatever the client sent (still encoded). */
export function parseProductPath(pathname: string): ProductPath | null {
  const match = /^\/(en\/)?product\/([^/]+)$/.exec(pathname);
  const slug = match?.[2];
  if (match === null || slug === undefined) return null;
  return { locale: match[1] === undefined ? 'uk' : 'en', slug };
}

/** An unmatched two-segment path: rendering it is the server-side 404 page, and no page cache entry exists for it. */
export const missingPath = (locale: 'uk' | 'en'): string => `/${locale}/__missing__/product`;
