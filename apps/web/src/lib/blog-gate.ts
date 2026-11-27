import { errorReason } from './error-reason';
import { createSlugSet } from './slug-set';

/**
 * The visible blog posts and tags in use, as `locale:slug` and `locale:tag:<tag>` keys. The proxy asks this before a blog
 * page renders, so an unknown address (or a post that has no body in this language) is answered with the shared 404
 * and never creates a page cache entry. Loaded lazily, refreshed once a minute and on every change (`invalidate`),
 * stale-on-error; until the first load succeeds the request passes and the page decides.
 */
export const knownBlogPages = createSlugSet(
  async () => {
    const { listBlogGateKeys } = await import('@store/core/blog');
    const { getDb } = await import('./db');
    return await listBlogGateKeys(await getDb());
  },
  {
    onError: (error) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'blog-gate', reason: errorReason(error) })}\n`,
      );
    },
  },
);
