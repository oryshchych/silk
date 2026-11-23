import { describe, expect, it } from 'vitest';

import { money } from '@store/shared/money';
import type { ProductImageDto } from '@store/shared/dto/catalog';

import { productImageUrls, uniqueOffers } from './product-jsonld';

const image = (url: string, colorSlug: string | null): ProductImageDto => ({
  url,
  alt: url,
  width: 800,
  height: 1000,
  colorSlug,
});

describe('productImageUrls', () => {
  const images = [
    image('https://cdn.example/white-1.webp', 'white'),
    image('/shared.jpg', null),
    image('https://cdn.example/black-1.webp', 'black'),
  ];

  it('puts the opening colour first, makes relative paths absolute and keeps every photo once', () => {
    expect(productImageUrls(images, 'black', 'https://shop.example')).toEqual([
      'https://shop.example/shared.jpg',
      'https://cdn.example/black-1.webp',
      'https://cdn.example/white-1.webp',
    ]);
  });

  it('returns nothing for a product without photos', () => {
    expect(productImageUrls([], 'black', 'https://shop.example')).toEqual([]);
  });
});

describe('uniqueOffers', () => {
  it('collapses variants with the same price and availability', () => {
    const offers = uniqueOffers(
      [
        { price: money(100_00), available: true },
        { price: money(100_00), available: true },
        { price: money(100_00), available: false },
        { price: money(120_00), available: true },
      ],
      'https://shop.example/product/a',
    );
    expect(offers.map((offer) => [offer.price, offer.availability])).toEqual([
      [10000, 'InStock'],
      [10000, 'OutOfStock'],
      [12000, 'InStock'],
    ]);
  });
});
