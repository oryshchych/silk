import { getSiteUrl } from '@/lib/site-url';
import { openSitemap, SITEMAP_HEADERS, sitemapGate } from '@/lib/sitemaps';

/** `pages.xml` and `products-<n>.xml`. Dynamic: see `lib/sitemaps.ts`. */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  // The gate covers opening (the count and the first query); the stream then reads in small batches.
  const result = await sitemapGate.run(async () => await openSitemap(await getSiteUrl(), name));
  if (!result.ran) return new Response('Busy', { status: 503, headers: { 'Retry-After': '30' } });
  if (result.value === null) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(result.value, { headers: SITEMAP_HEADERS });
}
