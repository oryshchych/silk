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
import { slugPath } from '@store/shared/sitemap-xml';

import { htmlToSnippet } from './html-text';

const BATCH = 1_000;
/** A feed this long is cut: a runaway table must not hold a connection for minutes. */
const MAX_FEED_ITEMS = 200_000;
const MAX_ACTIVE_FEEDS = 2;
let activeFeeds = 0;

/** A slot for one feed stream, held until the stream ends, fails or is cancelled; null when full. */
export function takeFeedSlot(): (() => void) | null {
  if (activeFeeds >= MAX_ACTIVE_FEEDS) return null;
  activeFeeds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeFeeds -= 1;
  };
}

export const FEED_HEADERS = {
  // A feed is for a crawler of a merchant platform, never for the search index.
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600',
} as const;

const absolute = (siteUrl: string, url: string | null): string | null =>
  url === null ? null : url.startsWith('/') ? `${siteUrl}${url}` : url;

/** An item without a photo is left out: Merchant Center disapproves it (`image_link` is required). */
export function toFeedItem(siteUrl: string, r: FeedVariantRow): FeedItem | null {
  const imageLink = absolute(siteUrl, r.image);
  if (imageLink === null) return null;
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
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          kind === 'google'
            ? googleFeedOpen({ title: siteName, link: siteUrl, description: siteName })
            : facebookCsvHeader(),
        ),
      );
    },
    cancel() {
      release();
    },
    async pull(controller) {
      if (finished) return;
      let rows: FeedVariantRow[];
      try {
        rows = await listFeedVariants(db, after, Math.min(BATCH, MAX_FEED_ITEMS - sent));
      } catch (error: unknown) {
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
        release();
        controller.close();
      }
    },
  });
}
