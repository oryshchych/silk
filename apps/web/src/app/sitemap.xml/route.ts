import { getSiteUrl } from '@/lib/site-url';
import { renderSitemapIndex, SITEMAP_HEADERS, sitemapGate } from '@/lib/sitemaps';

/** Sitemap index. Dynamic on purpose: the origin is a runtime value (ADR-10) and nothing is cached by Next. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const result = await sitemapGate.run(async () => await renderSitemapIndex(await getSiteUrl()));
  if (!result.ran) return new Response('Busy', { status: 503, headers: { 'Retry-After': '30' } });
  return new Response(result.value, { headers: SITEMAP_HEADERS });
}
