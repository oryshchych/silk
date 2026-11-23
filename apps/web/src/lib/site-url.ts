import { env } from '@store/shared/env';
import { resolveSiteUrl } from '@store/shared/seo';

/**
 * Public origin, read from the runtime environment (ADR-10). Pages that call
 * this must not be prerendered at build time, otherwise the build host would
 * be baked into canonical and hreflang URLs: the catalog routes have no
 * `generateStaticParams`, so they render on the first request and are cached
 * by ISR afterwards.
 */
export function getSiteUrl(): string {
  return resolveSiteUrl(env);
}
