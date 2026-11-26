import { errorReason } from './error-reason';
import { createSlugSet } from './slug-set';

/**
 * The legal pages that are published, as `locale:kind` keys. The proxy asks this before a legal page renders, so
 * a page that exists in one language only is answered in the other with the shared 404 (which carries the
 * trademark disclaimer) and never creates a page cache entry. Loaded lazily from the database, refreshed once a
 * minute and on every publish (`invalidate`), stale-on-error; until the first load the request passes and the
 * page decides.
 */
export const knownLegalPages = createSlugSet(
  async () => {
    const { listCurrentLegalNav } = await import('@store/core/legal-read');
    const { getDb } = await import('./db');
    return (await listCurrentLegalNav(await getDb())).map((row) => `${row.locale}:${row.kind}`);
  },
  {
    onError: (error) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'legal-gate', reason: errorReason(error) })}\n`,
      );
    },
  },
);
