/**
 * The sitemap bodies. Nothing here is cached by Next (the routes are dynamic), so no request value
 * can become a cache key: the file name is checked against the real file count first, and a
 * product file is streamed from the database in keyset batches instead of being built in memory.
 */
import {
  parseSitemapName,
  productFileCount,
  SITEMAP_PRODUCTS_PER_FILE,
  sitemapIndexXml,
  URLSET_CLOSE,
  URLSET_OPEN,
  urlEntries,
} from '@store/shared/sitemap-xml';

import { createSemaphore } from './semaphore';
import { paths } from './paths';

const BATCH = 2_000;
/** Building a sitemap reads many rows: two at a time, a few may wait, the rest are told to retry. */
export const sitemapGate = createSemaphore(2, 4);

export const SITEMAP_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
} as const;

async function reader() {
  const { getDb } = await import('./db');
  return await getDb();
}

export async function renderSitemapIndex(siteUrl: string): Promise<string> {
  const { countSitemapProducts } = await import('@store/core/sitemap');
  const files = productFileCount(await countSitemapProducts(await reader()));
  const locs = [
    `${siteUrl}/sitemaps/pages.xml`,
    ...Array.from({ length: files }, (_, i) => `${siteUrl}/sitemaps/products-${String(i)}.xml`),
  ];
  return sitemapIndexXml(locs);
}

/** A stream of the file, or null when the name is not a file of the current sitemap. */
export async function openSitemap(
  siteUrl: string,
  name: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const core = await import('@store/core/sitemap');
  const db = await reader();
  const parsed = parseSitemapName(name, productFileCount(await core.countSitemapProducts(db)));
  if (parsed === null) return null;
  const encoder = new TextEncoder();

  if (parsed.kind === 'pages') {
    const categories = await core.listSitemapCategories(db);
    const body =
      URLSET_OPEN +
      urlEntries(siteUrl, { path: paths.home, lastmod: null }) +
      categories
        .map((c) => urlEntries(siteUrl, { path: paths.category(c.slug), lastmod: c.lastmod }))
        .join('') +
      URLSET_CLOSE;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  }

  const start = await core.sitemapFileStart(db, parsed.index, SITEMAP_PRODUCTS_PER_FILE);
  let next: string | null = start;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(URLSET_OPEN));
    },
    async pull(controller) {
      const remaining = SITEMAP_PRODUCTS_PER_FILE - sent;
      if (next === null || remaining <= 0) {
        controller.enqueue(encoder.encode(URLSET_CLOSE));
        controller.close();
        return;
      }
      const rows = await core.listSitemapProducts(db, next, Math.min(BATCH, remaining) + 1);
      const page = rows.slice(0, Math.min(BATCH, remaining));
      controller.enqueue(
        encoder.encode(
          page
            .map((p) => urlEntries(siteUrl, { path: paths.product(p.slug), lastmod: p.lastmod }))
            .join(''),
        ),
      );
      sent += page.length;
      // The extra row (if any) is where the next batch starts; none means the end.
      next = rows.length > page.length ? (rows[page.length]?.slug ?? null) : null;
    },
  });
}
