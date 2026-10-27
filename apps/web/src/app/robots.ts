import type { MetadataRoute } from 'next';
import { connection } from 'next/server';

/**
 * robots.txt. Поза production — Disallow усього (третій шар захисту
 * staging після basic auth і X-Robots-Tag, ENVIRONMENTS.md).
 *
 * APP_ENV читається під час ЗАПИТУ, а не збірки (ADR-10): один образ
 * обслуговує і staging, і production.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  const { env } = await import('@store/shared/env');
  if (env.APP_ENV !== 'production') {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  // Sitemap і правила для фасетів — фаза 6 (SEO).
  return { rules: { userAgent: '*', allow: '/' } };
}
