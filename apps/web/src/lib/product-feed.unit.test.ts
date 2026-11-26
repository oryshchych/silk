import { describe, expect, it } from 'vitest';

import type { FeedVariantRow } from '@store/core/feed';

import { takeFeedSlot, toFeedItem } from './product-feed';

const row = (over: Partial<FeedVariantRow> = {}): FeedVariantRow => ({
  variantId: '0190a1b2-0000-7000-8000-0000000000aa',
  sku: 'AUR-75B-BLK',
  barcode: null,
  productId: '0190a1b2-0000-7000-8000-000000000001',
  slug: 'aurora',
  brand: 'Aurelia',
  name: 'Бюстгальтер «Аврора»',
  shortDescription: '<p>Короткий <b>опис</b></p><script>x()</script>',
  description: null,
  price: 129_900,
  compareAtPrice: 159_900,
  size: '75B',
  color: 'Чорний',
  available: true,
  category: 'Білизна > Бюстгальтери',
  image: '/media/a.jpg',
  additionalImages: ['https://media.example/b.jpg'],
  ...over,
});

describe('toFeedItem', () => {
  it('builds absolute links on the runtime origin and strips markup from the description', () => {
    const item = toFeedItem('https://shop.example', row());
    expect(item?.link).toBe('https://shop.example/product/aurora');
    expect(item?.imageLink).toBe('https://shop.example/media/a.jpg');
    expect(item?.description).toBe('Короткий опис');
    expect(item?.price).toBe(159_900);
    expect(item?.salePrice).toBe(129_900);
  });

  it('a compare-at price that is not above the price is no sale', () => {
    const item = toFeedItem('https://s.example', row({ compareAtPrice: 129_900 }));
    expect(item?.price).toBe(129_900);
    expect(item?.salePrice).toBeNull();
  });

  it('percent-encodes a slug in the link and leaves a photo-less variant out', () => {
    expect(toFeedItem('https://s.example', row({ slug: 'a?b#c' }))?.link).toBe(
      'https://s.example/product/a%3Fb%23c',
    );
    expect(toFeedItem('https://s.example', row({ image: null }))).toBeNull();
  });

  it('keeps the product id as the group, not the slug (a rename must not split a group)', () => {
    expect(toFeedItem('https://s.example', row())?.groupId).toBe(
      '0190a1b2-0000-7000-8000-000000000001',
    );
  });
});

describe('takeFeedSlot', () => {
  it('allows two streams at once, refuses the third, and frees a slot once (release is idempotent)', () => {
    const a = takeFeedSlot();
    const b = takeFeedSlot();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(takeFeedSlot()).toBeNull();
    a?.();
    a?.();
    const c = takeFeedSlot();
    expect(c).not.toBeNull();
    expect(takeFeedSlot()).toBeNull();
    b?.();
    c?.();
    expect(takeFeedSlot()).not.toBeNull();
  });
});
