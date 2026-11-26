import type { MetadataRoute } from 'next';
import { connection } from 'next/server';

import { robotsRules } from '@/lib/robots-rules';

/**
 * robots.txt. Outside production: Disallow everything (the third layer that keeps staging out of
 * search, after basic auth and X-Robots-Tag, ENVIRONMENTS.md). In production: the private and
 * transactional routes are closed, the sitemap index is announced.
 *
 * APP_ENV and SITE_URL are read at REQUEST time, not build time (ADR-10): one image serves both.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  const { env } = await import('@store/shared/env');
  const { getSiteUrl } = await import('@/lib/site-url');
  return robotsRules(env.APP_ENV, await getSiteUrl());
}
