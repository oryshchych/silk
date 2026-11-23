import { describe, expect, it } from 'vitest';

import { money } from './money';
import {
  buildBreadcrumbList,
  buildItemList,
  buildProduct,
  priceToDecimal,
  serializeJsonLd,
  type ProductInput,
} from './schema-org';

describe('priceToDecimal', () => {
  it('formats kopiykas exactly, without floats', () => {
    expect(priceToDecimal(money(129900))).toBe('1299.00');
    expect(priceToDecimal(money(5))).toBe('0.05');
    expect(priceToDecimal(money(100))).toBe('1.00');
    expect(priceToDecimal(money(99999999))).toBe('999999.99');
  });
});

describe('buildBreadcrumbList', () => {
  it('numbers crumbs from 1 and keeps absolute URLs', () => {
    const ld = buildBreadcrumbList([
      { name: 'Home', url: 'https://shop.example/' },
      { name: 'Bras', url: 'https://shop.example/category/bras' },
    ]);
    expect(ld['@type']).toBe('BreadcrumbList');
    expect(ld.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(ld.itemListElement[1]?.item).toBe('https://shop.example/category/bras');
  });
});

describe('buildItemList', () => {
  const items = [
    { name: 'A', url: 'https://shop.example/product/a' },
    { name: 'B', url: 'https://shop.example/product/b' },
  ];

  it('numbers from 1 by default and continues across pages', () => {
    expect(buildItemList(items).itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(buildItemList(items, 25).itemListElement.map((i) => i.position)).toEqual([25, 26]);
  });
});

describe('buildProduct', () => {
  const base: ProductInput = {
    name: 'Bra Aurora',
    description: 'Soft lace bra',
    sku: 'AUR-001',
    brand: 'Aurelia',
    images: ['https://shop.example/img/1.webp'],
    url: 'https://shop.example/product/aurora',
    offers: [
      {
        price: money(129900),
        availability: 'InStock',
        url: 'https://shop.example/product/aurora',
      },
    ],
    rating: { value: 4.5, count: 12 },
  };

  it('builds a single Offer with an exact UAH price', () => {
    const ld = buildProduct(base);
    expect(ld['@type']).toBe('Product');
    expect(ld.offers).toMatchObject({
      '@type': 'Offer',
      price: '1299.00',
      priceCurrency: 'UAH',
      availability: 'https://schema.org/InStock',
    });
    expect(ld.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.5,
      reviewCount: 12,
    });
  });

  it('builds an AggregateOffer for several prices and is InStock if any offer is', () => {
    const ld = buildProduct({
      ...base,
      offers: [
        { price: money(129900), availability: 'OutOfStock', url: base.url },
        { price: money(109900), availability: 'InStock', url: base.url },
      ],
    });
    expect(ld.offers).toMatchObject({
      '@type': 'AggregateOffer',
      lowPrice: '1099.00',
      highPrice: '1299.00',
      offerCount: 2,
      availability: 'https://schema.org/InStock',
    });
  });

  it('is OutOfStock when every offer is', () => {
    const ld = buildProduct({
      ...base,
      offers: [
        { price: money(100), availability: 'OutOfStock', url: base.url },
        { price: money(200), availability: 'OutOfStock', url: base.url },
      ],
    });
    expect(ld.offers).toMatchObject({ availability: 'https://schema.org/OutOfStock' });
  });

  it('omits empty optional fields instead of emitting nulls', () => {
    const ld = buildProduct({
      ...base,
      description: null,
      images: [],
      rating: { value: 5, count: 0 },
    });
    expect(ld).not.toHaveProperty('description');
    expect(ld).not.toHaveProperty('image');
    expect(ld).not.toHaveProperty('aggregateRating');
  });

  it('refuses a product without offers', () => {
    expect(() => buildProduct({ ...base, offers: [] })).toThrow(RangeError);
  });
});

describe('serializeJsonLd', () => {
  it('cannot be closed early by product text', () => {
    const json = serializeJsonLd({ name: '</script><script>alert(1)</script> & co' });
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(json).not.toContain('&');
    expect(JSON.parse(json)).toEqual({ name: '</script><script>alert(1)</script> & co' });
  });

  it('escapes the line separators', () => {
    const separators = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
    const json = serializeJsonLd({ a: separators });
    expect(json).not.toContain(String.fromCharCode(0x2028));
    expect(json).not.toContain(String.fromCharCode(0x2029));
    expect(JSON.parse(json)).toEqual({ a: separators });
  });
});
