/**
 * Shape of a product slug: lowercase words joined by single hyphens, at most
 * 200 characters (the column is varchar(200)). Anything else cannot exist, so
 * it is rejected before it reaches SQL (a NUL byte in a parameter is a
 * Postgres error) or a cache. Pure, so the proxy can use it without the
 * database code.
 */
export const isProductSlug = (slug: string): boolean =>
  slug.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
