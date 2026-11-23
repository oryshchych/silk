import { resolveSiteUrl } from '@store/shared/seo';

/**
 * Public origin, read from the runtime environment (ADR-10). Pages that call
 * this must not be prerendered at build time, otherwise the build host would
 * be baked into canonical and hreflang URLs: the catalog routes have no
 * `generateStaticParams`, so they render on the first request and are cached
 * by ISR afterwards.
 *
 * The environment module is imported lazily: it validates the whole
 * environment on import, and `next build` (CI, Docker) has none.
 */
export async function getSiteUrl(): Promise<string> {
  const { env } = await import('@store/shared/env');
  return resolveSiteUrl(env);
}
