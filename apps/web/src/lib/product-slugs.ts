import { errorReason } from './error-reason';
import { createSlugSet } from './slug-set';

/**
 * Slugs of the products the storefront shows. The proxy asks this before a
 * product page renders, so an unknown slug never creates a page-cache entry.
 * Loaded lazily from the database (the environment is imported lazily too).
 * A failed load is logged (name and code only) and the last good set is kept.
 */
export const knownProductSlugs = createSlugSet(
  async () => {
    const { listVisibleProductSlugs } = await import('@store/core/catalog');
    const { getDb } = await import('./db');
    return await listVisibleProductSlugs(await getDb());
  },
  {
    onError: (error) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'slug-gate', reason: errorReason(error) })}\n`,
      );
    },
  },
);
