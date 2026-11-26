/**
 * Streams the product feeds. Like the sitemaps: dynamic routes (nothing in Next's cache), a
 * semaphore around the read, keyset batches from the database, absolute links on the runtime
 * origin (ADR-10). An item is built from the explicit `FeedVariantRow` list only.
 */
import type { FeedVariantRow } from '@store/core/feed';
import { money } from '@store/shared/money';
import {
  facebookCsvHeader,
  facebookCsvRow,
  GOOGLE_FEED_CLOSE,
  googleFeedOpen,
  googleItemXml,
  validGtin,
  type FeedItem,
} from '@store/shared/product-feed';
import { FEED_MAX_ID_LENGTH } from '@store/shared/content-bounds';
import { slugPath } from '@store/shared/sitemap-xml';

import { htmlToSnippet } from './html-text';
import { createSemaphore } from './semaphore';

const BATCH = 1_000;
/** A feed this long is cut: a runaway table must not hold a connection for minutes. */
const MAX_FEED_ITEMS = 200_000;
/**
 * Concurrency, in two layers. At most `MAX_STREAMS` feeds are open at once (a slot is held until the
 * stream ends, fails, is cancelled, is aborted by the client or passes the deadline), and at most
 * two database reads run at any moment (`batchGate`), so a slow reader holds a stream but never
 * the database. A stream that has not finished after `FEED_DEADLINE_MS` is cut: a socket that
 * reads nothing cannot hold a slot for ever.
 */
const MAX_STREAMS = 8;
export const FEED_DEADLINE_MS = 120_000;
const batchGate = createSemaphore(2, 32);
let openStreams = 0;

/** A slot for one feed stream; null when all are taken. The release is idempotent. */
export function takeFeedSlot(): (() => void) | null {
  if (openStreams >= MAX_STREAMS) return null;
  openStreams += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openStreams -= 1;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const FEED_HEADERS = {
  // A feed is for a crawler of a merchant platform, never for the search index.
  'X-Robots-Tag': 'noindex',
  'Cache-Control':
    'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600, stale-if-error=86400',
} as const;

const absolute = (siteUrl: string, url: string | null): string | null =>
  url === null ? null : url.startsWith('/') ? `${siteUrl}${url}` : url;

/** An item without a photo or with an over-long id is left out: Merchant Center would disapprove it. */
export function toFeedItem(siteUrl: string, r: FeedVariantRow): FeedItem | null {
  const imageLink = absolute(siteUrl, r.image);
  if (imageLink === null) return null;
  // Google's limit for `id` is 50 characters; a longer SKU cannot be listed (truncating would break the key).
  if (r.sku.length > FEED_MAX_ID_LENGTH) return null;
  const onSale = r.compareAtPrice !== null && r.compareAtPrice > r.price;
  const description = htmlToSnippet(r.shortDescription ?? r.description, 5000) ?? r.name;
  return {
    id: r.sku,
    groupId: r.productId,
    title: r.name,
    description,
    link: `${siteUrl}${slugPath('product', r.slug)}`,
    imageLink,
    additionalImages: r.additionalImages.flatMap((url) => {
      const full = absolute(siteUrl, url);
      return full === null ? [] : [full];
    }),
    inStock: r.available,
    price: money(onSale && r.compareAtPrice !== null ? r.compareAtPrice : r.price),
    salePrice: onSale ? money(r.price) : null,
    brand: r.brand,
    gtin: validGtin(r.barcode),
    mpn: r.sku,
    size: r.size,
    color: r.color,
    productType: r.category,
  };
}

export type FeedKind = 'google' | 'facebook';

export const FEED_TYPES: Record<FeedKind, string> = {
  google: 'application/xml; charset=utf-8',
  facebook: 'text/csv; charset=utf-8',
};

export async function openFeed(
  siteUrl: string,
  siteName: string,
  kind: FeedKind,
  release: () => void,
): Promise<ReadableStream<Uint8Array>> {
  let db;
  let listFeedVariants;
  try {
    ({ listFeedVariants } = await import('@store/core/feed'));
    db = await (await import('./db')).getDb();
  } catch (error: unknown) {
    release();
    throw error;
  }
  const encoder = new TextEncoder();
  let after: string | null = null;
  let sent = 0;
  let finished = false;
  let cut = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // A timer, not a check inside `pull`: a reader that reads nothing never calls `pull`.
      deadline = setTimeout(() => {
        cut = true;
        release();
        controller.error(new Error('feed deadline passed'));
      }, FEED_DEADLINE_MS);
      deadline.unref();
      controller.enqueue(
        encoder.encode(
          kind === 'google'
            ? googleFeedOpen({ title: siteName, link: siteUrl, description: siteName })
            : facebookCsvHeader(),
        ),
      );
    },
    cancel() {
      clearTimeout(deadline);
      release();
    },
    async pull(controller) {
      if (finished) return;
      let rows: FeedVariantRow[];
      try {
        // Wait for a database slot, but not past the deadline (the timer sets `cut`).
        for (;;) {
          if (cut) return;
          const read = await batchGate.run(
            async () => await listFeedVariants(db, after, Math.min(BATCH, MAX_FEED_ITEMS - sent)),
          );
          if (read.ran) {
            rows = read.value;
            break;
          }
          await sleep(100);
        }
      } catch (error: unknown) {
        clearTimeout(deadline);
        release();
        throw error;
      }
      const items = rows.flatMap((r) => {
        const built = toFeedItem(siteUrl, r);
        return built === null ? [] : [built];
      });
      controller.enqueue(
        encoder.encode(
          items
            .map((item) => (kind === 'google' ? googleItemXml(item) : facebookCsvRow(item)))
            .join(''),
        ),
      );
      sent += rows.length;
      after = rows.at(-1)?.variantId ?? after;
      if (rows.length < BATCH || sent >= MAX_FEED_ITEMS) {
        if (kind === 'google') controller.enqueue(encoder.encode(GOOGLE_FEED_CLOSE));
        finished = true;
        clearTimeout(deadline);
        release();
        controller.close();
      }
    },
  });
}
