/**
 * The sitemap bodies. Nothing here is cached by Next (the routes are dynamic), so no request value
 * can become a cache key. A file name is checked by syntax first, with no database and no gate;
 * the file split (the first slug of every file) is computed once per minute and shared by the
 * index and the files, so they agree and a request does not run a full-table count. A product
 * file is streamed from the database in keyset batches instead of being built in memory.
 */
import {
  isSitemapFileName,
  parseSitemapName,
  SITEMAP_PRODUCTS_PER_FILE,
  sitemapIndexXml,
  slugPath,
  legalUrlEntries,
  URLSET_CLOSE,
  URLSET_OPEN,
  urlEntries,
} from '@store/shared/sitemap-xml';

import { LEGAL_KINDS, legalPath } from '@store/shared/legal';

import { createSemaphore } from './semaphore';
import { paths } from './paths';

const BATCH = 2_000;
const PLAN_TTL_MS = 60_000;
/** Building a sitemap reads many rows: two at a time, a few may wait, the rest are told to retry. */
export const sitemapGate = createSemaphore(2, 4);

export const SITEMAP_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  'Cache-Control':
    'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400',
} as const;

async function reader() {
  const { getDb } = await import('./db');
  return await getDb();
}

interface Plan {
  /** First slug of every product file (empty: no products). */
  starts: readonly string[];
  at: number;
}

let plan: Plan | null = null;
let planning: Promise<Plan> | null = null;

/** The file split, shared by every request for a minute (single flight). */
function sitemapPlan(now: number = performance.now()): Promise<Plan> {
  if (plan !== null && now - plan.at < PLAN_TTL_MS) return Promise.resolve(plan);
  planning ??= (async () => {
    const { sitemapFileStarts } = await import('@store/core/sitemap');
    const starts = await sitemapFileStarts(await reader(), SITEMAP_PRODUCTS_PER_FILE);
    plan = { starts, at: performance.now() };
    return plan;
  })().finally(() => {
    planning = null;
  });
  return planning;
}

const productFiles = (starts: readonly string[]): number => Math.max(1, starts.length);

export async function renderSitemapIndex(siteUrl: string): Promise<string> {
  const { starts } = await sitemapPlan();
  const locs = [
    `${siteUrl}/sitemaps/pages.xml`,
    ...Array.from(
      { length: productFiles(starts) },
      (_, i) => `${siteUrl}/sitemaps/products-${String(i)}.xml`,
    ),
  ];
  return sitemapIndexXml(locs);
}

/** True when the name is worth a database call and a gate slot. */
export const plausibleSitemapName = isSitemapFileName;

/** A stream of the file, or null when the name is not a file of the current sitemap. */
export async function openSitemap(
  siteUrl: string,
  name: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const core = await import('@store/core/sitemap');
  const { starts } = await sitemapPlan();
  const parsed = parseSitemapName(name, productFiles(starts));
  if (parsed === null) return null;
  const db = await reader();
  const encoder = new TextEncoder();

  if (parsed.kind === 'pages') {
    const categories = await core.listSitemapCategories(db);
    const { listLegalForSitemap } = await import('@store/core/legal-read');
    // The REAL date each current legal page took effect; a page appears only for the languages published.
    const legal = await listLegalForSitemap(db);
    const legalXml = LEGAL_KINDS.map((kind) =>
      legalUrlEntries(
        siteUrl,
        legalPath(kind),
        legal
          .filter((row) => row.kind === kind)
          .map((row) => ({
            locale: row.locale,
            lastmod: row.lastmod.toISOString().replace(/\.\d+Z$/, 'Z'),
          })),
      ),
    ).join('');
    const { listBlogForSitemap } = await import('@store/core/blog');
    const blog = await listBlogForSitemap(db);
    const stamp = (date: Date): string => date.toISOString().replace(/\.\d+Z$/, 'Z');
    // The index in both languages; a post only in the languages it has a body in (a hreflang pair only when both).
    const blogXml =
      legalUrlEntries(
        siteUrl,
        paths.blog,
        (['uk', 'en'] as const).map((locale) => ({
          locale,
          lastmod: blog[0] === undefined ? '' : stamp(blog[0].lastmod),
        })),
      ) +
      blog
        .map((post) =>
          legalUrlEntries(
            siteUrl,
            paths.blogPost(post.slug),
            post.locales.map((locale) => ({ locale, lastmod: stamp(post.lastmod) })),
          ),
        )
        .join('');
    const body =
      URLSET_OPEN +
      urlEntries(siteUrl, { path: paths.home, lastmod: null }) +
      categories
        .map((c) => urlEntries(siteUrl, { path: slugPath('category', c.slug), lastmod: c.lastmod }))
        .join('') +
      legalXml +
      blogXml +
      URLSET_CLOSE;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  }

  const from = starts[parsed.index];
  const until = starts[parsed.index + 1] ?? null;
  let next: string | null = from ?? null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(URLSET_OPEN));
    },
    async pull(controller) {
      if (next === null) {
        controller.enqueue(encoder.encode(URLSET_CLOSE));
        controller.close();
        return;
      }
      const rows = await core.listSitemapProducts(db, { from: next, until }, BATCH + 1);
      const page = rows.slice(0, BATCH);
      controller.enqueue(
        encoder.encode(
          page
            .map((p) =>
              urlEntries(siteUrl, { path: slugPath('product', p.slug), lastmod: p.lastmod }),
            )
            .join(''),
        ),
      );
      // The extra row (if any) is where the next batch starts; none means the end.
      next = rows.length > page.length ? (rows[page.length]?.slug ?? null) : null;
    },
  });
}
