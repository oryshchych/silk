import { describe, expect, it } from 'vitest';

import {
  CONTENT_BOUNDS,
  FEED_MAX_ID_LENGTH,
  TITLE_DISPLAY_MAX,
  TITLE_SUFFIX_RESERVE,
} from '@store/shared/content-bounds';
import type { FeedVariantRow } from '@store/core/feed';

import en from '../../messages/en.json';
import uk from '../../messages/uk.json';
import { toFeedItem } from './product-feed';

/** The storefront writes `<title>` as `${metaTitle} | ${siteName}`; the bound must leave room for it. */
describe('the meta title bound and the real title', () => {
  for (const [locale, messages] of [
    ['uk', uk],
    ['en', en],
  ] as const) {
    it(`${locale}: a longest allowed meta title plus the suffix fits the displayed width`, () => {
      const suffix = ` | ${messages.meta.siteName}`;
      expect(suffix.length).toBeLessThanOrEqual(TITLE_SUFFIX_RESERVE);
      expect(CONTENT_BOUNDS.metaTitle.max + suffix.length).toBeLessThanOrEqual(TITLE_DISPLAY_MAX);
    });
  }
});

const row = (sku: string): FeedVariantRow => ({
  variantId: '0193f0a4-7c3e-7000-8000-000000000001',
  sku,
  barcode: null,
  productId: '0193f0a4-7c3e-7000-8000-000000000002',
  slug: 'item',
  brand: 'Brand',
  name: 'Name',
  shortDescription: null,
  description: null,
  price: 100_00,
  compareAtPrice: null,
  size: 'S',
  color: 'Black',
  available: true,
  category: 'Cat',
  image: 'https://media.example.test/a.webp',
  additionalImages: [],
});

describe('the SKU limit the readiness report uses is the one the feed enforces', () => {
  it('keeps a SKU at the limit and drops one character more', () => {
    expect(toFeedItem('https://shop.example', row('S'.repeat(FEED_MAX_ID_LENGTH)))).not.toBeNull();
    expect(toFeedItem('https://shop.example', row('S'.repeat(FEED_MAX_ID_LENGTH + 1)))).toBeNull();
  });
});
