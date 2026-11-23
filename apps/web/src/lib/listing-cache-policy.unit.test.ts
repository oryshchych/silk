import { describe, expect, it } from 'vitest';

import { parseListingParams } from '@store/core/catalog';

import { isCacheableListing } from './listing-cache-policy';

const cacheable = (query: Record<string, string>) => isCacheableListing(parseListingParams(query));

describe('isCacheableListing', () => {
  it('caches the clean category, sorting, paging and up to three filter values', () => {
    expect(cacheable({})).toBe(true);
    expect(cacheable({ sort: 'price_asc', page: '2' })).toBe(true);
    expect(cacheable({ band: '75', cup: 'B', color: 'black' })).toBe(true);
    expect(cacheable({ band: '70,75,80' })).toBe(true);
  });

  it('does not cache four or more filter values', () => {
    expect(cacheable({ band: '70,75', cup: 'A,B' })).toBe(false);
    expect(cacheable({ band: '75', cup: 'B', color: 'black', brand: 'Aurelia' })).toBe(false);
  });

  it('never caches a price range', () => {
    expect(cacheable({ price_min: '100' })).toBe(false);
    expect(cacheable({ price_max: '900' })).toBe(false);
  });
});
