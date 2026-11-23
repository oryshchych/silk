import { describe, expect, it } from 'vitest';

import { defaultListingParams, parseListingParams } from '@store/core/catalog';

import { listingSeo } from './listing-seo';

const seo = (query: Record<string, string>) => listingSeo(parseListingParams(query));

describe('listingSeo', () => {
  it('indexes the clean category with the clean canonical', () => {
    expect(listingSeo(defaultListingParams)).toEqual({ index: true, canonicalSearch: '' });
  });

  it('indexes one whitelisted filter (a single band) with its own canonical', () => {
    expect(seo({ band: '75' })).toEqual({ index: true, canonicalSearch: 'band=75' });
  });

  it('does not index two filters, other single filters, sort or page 2+', () => {
    for (const query of [
      { band: '75', cup: 'B' },
      { band: '75,80' },
      { color: 'black' },
      { cup: 'B' },
      { sort: 'price_asc' },
      { page: '2' },
      { band: '75', page: '2' },
      { band: '75', sort: 'price_desc' },
    ]) {
      expect(seo(query)).toEqual({ index: false, canonicalSearch: '' });
    }
  });

  it('ignores junk values so a junk URL is the clean category', () => {
    expect(seo({ band: '72', foo: 'bar' })).toEqual({ index: true, canonicalSearch: '' });
  });
});
