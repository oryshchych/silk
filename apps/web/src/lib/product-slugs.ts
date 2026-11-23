import { createSlugSet } from './slug-set';

/**
 * Slugs of the products the storefront shows. The proxy asks this before a
 * product page renders, so an unknown slug never creates a page-cache entry.
 * Loaded lazily from the database (the environment is imported lazily too).
 */
export const knownProductSlugs = createSlugSet(async () => {
  const { listVisibleProductSlugs } = await import('@store/core/catalog');
  const { getDb } = await import('./db');
  return await listVisibleProductSlugs(await getDb());
});
