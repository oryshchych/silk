import { describe, expect, it } from 'vitest';

import {
  defaultListingParams,
  parseListingParams,
  restrictListingParams,
  serializeListingParams,
  type ListingParams,
  type RawSearchParams,
} from './listing-params';

const roundTrip = (query: string): string => {
  const raw: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) (raw[key] ??= []).push(value);
  return serializeListingParams(parseListingParams(raw));
};

describe('parseListingParams', () => {
  it('gives the defaults for an empty query', () => {
    expect(parseListingParams({})).toEqual(defaultListingParams);
  });

  it('reads three filters together, repeated or comma-separated', () => {
    const params = parseListingParams({ band: ['80', '75'], cup: 'B,C', color: 'black' });
    expect(params.bands).toEqual([75, 80]);
    expect(params.cups).toEqual(['B', 'C']);
    expect(params.colors).toEqual(['black']);
  });

  it('drops invalid values instead of failing', () => {
    const raw: RawSearchParams = {
      band: ['72', '75', 'abc', '200'],
      cup: ['b', 'B', 'TOOLONG'],
      color: ['Black', 'black', "x'; drop table"],
      sort: 'random',
      page: '-3',
      price_min: 'cheap',
      price_max: '1.5',
    };
    const params = parseListingParams(raw);
    expect(params.bands).toEqual([75]);
    expect(params.cups).toEqual(['B']);
    expect(params.colors).toEqual(['black']);
    expect(params.sort).toBe('newest');
    expect(params.page).toBe(1);
    expect(params.priceMin).toBeNull();
    expect(params.priceMax).toBeNull();
  });

  it('converts hryvnias to kopiykas and swaps an inverted range', () => {
    const params = parseListingParams({ price_min: '2000', price_max: '500' });
    expect(params.priceMin).toBe(50_000);
    expect(params.priceMax).toBe(200_000);
  });

  it('clamps the page and caps the number of values', () => {
    expect(parseListingParams({ page: '99999' }).page).toBe(1);
    expect(parseListingParams({ page: '1000' }).page).toBe(1000);
    const many = Array.from({ length: 50 }, (_, i) => `brand${String(i)}`);
    expect(parseListingParams({ brand: many }).brands).toHaveLength(20);
  });

  it('reads flags only from the value 1', () => {
    expect(parseListingParams({ in_stock: '1', sale: 'true' })).toMatchObject({
      inStock: true,
      onSale: false,
    });
  });
});

describe('serializeListingParams', () => {
  it('omits defaults and orders keys and values stably', () => {
    expect(serializeListingParams(defaultListingParams)).toBe('');
    expect(roundTrip('color=black&cup=C&cup=B&band=80&band=75&sort=price_asc&page=2')).toBe(
      'band=75,80&cup=B,C&color=black&sort=price_asc&page=2',
    );
  });

  it('is idempotent: a normalised query stays the same', () => {
    const once = roundTrip('page=3&brand=Aurelia&in_stock=1&price_min=300');
    expect(roundTrip(once)).toBe(once);
    expect(once).toBe('brand=Aurelia&price_min=300&in_stock=1&page=3');
  });

  it('keeps non-ASCII brand names URL-safe', () => {
    const once = roundTrip('brand=Нова лінія');
    expect(once).toBe(`brand=${encodeURIComponent('Нова лінія')}`);
    expect(roundTrip(once)).toBe(once);
  });
});

describe('restrictListingParams', () => {
  const known = {
    bands: [70, 75],
    cups: ['A', 'B'],
    sizes: [{ label: 'M' }],
    colors: [{ slug: 'black' }],
    brands: ['Aurelia'],
  };

  it('keeps values the category offers and drops invented ones', () => {
    const params = parseListingParams({
      band: ['75', '80'],
      cup: 'B,C',
      size: 'M,XL',
      color: 'black,made-up',
      brand: ['Aurelia', 'x'.repeat(100)],
      sort: 'price_asc',
      price_min: '100',
      page: '3',
    });
    const restricted = restrictListingParams(params, known);
    expect(restricted).toMatchObject({
      bands: [75],
      cups: ['B'],
      sizes: ['M'],
      colors: ['black'],
      brands: ['Aurelia'],
      sort: 'price_asc',
      priceMin: 10_000,
      page: 3,
    });
  });

  it('turns a query of invented values into the clean category', () => {
    const params = parseListingParams({ brand: 'nobody', color: 'nothing' });
    expect(serializeListingParams(restrictListingParams(params, known))).toBe('');
  });
});

describe('ListingParams brand', () => {
  it('cannot be built by hand, only by the parser', () => {
    const { bands, cups, sizes, colors, brands, priceMin, priceMax, inStock, onSale, sort, page } =
      defaultListingParams;
    // @ts-expect-error: a hand-built object lacks the brand, so it cannot reach cache keys or SQL
    const byHand: ListingParams = {
      bands,
      cups,
      sizes,
      colors,
      brands,
      priceMin,
      priceMax,
      inStock,
      onSale,
      sort,
      page,
    };
    expect(byHand.page).toBe(1);
  });
});
