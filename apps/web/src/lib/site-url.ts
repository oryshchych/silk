import { resolveSiteUrl } from '@store/shared/seo';

/**
 * Public origin, read from the runtime environment (ADR-10).
 *
 * It must never run while `next build` prerenders a page, or the build host
 * would be baked into canonical and hreflang URLs. That is enforced here: the
 * build fails loudly if a statically generated page calls it. (An
 * `await connection()` would also work, but it turns off caching, which the
 * catalog pages need.)
 *
 * The environment module is imported lazily: it validates the whole
 * environment on import, and `next build` (CI, Docker) has none.
 */
export async function getSiteUrl(): Promise<string> {
  // eslint-disable-next-line no-restricted-properties -- NEXT_PHASE is a Next.js build constant, not application configuration
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error(
      'getSiteUrl() ran during `next build`: a page that reads the site URL must not be prerendered (ADR-10).',
    );
  }
  const { env } = await import('@store/shared/env');
  return resolveSiteUrl(env);
}
