import { describe, expect, it } from 'vitest';

import { readSearchQuery } from './search-query';

describe('readSearchQuery', () => {
  it('reads the first q and page', () => {
    expect(readSearchQuery({ q: ['bra', 'other'], page: '3' })).toEqual({ query: 'bra', page: 3 });
    expect(readSearchQuery({})).toEqual({ query: '', page: 1 });
  });

  it('bounds the query to 100 characters and strips control characters', () => {
    expect(readSearchQuery({ q: 'a'.repeat(500) }).query).toHaveLength(100);
    expect(readSearchQuery({ q: 'br\u0000a' }).query).toBe('br a');
  });

  it('falls back to page 1 for junk and clamps a huge page', () => {
    for (const page of ['-3', '0x10', 'abc', '99999', '1.5', '']) {
      expect(readSearchQuery({ q: 'bra', page }).page).toBe(1);
    }
    expect(readSearchQuery({ q: 'bra', page: '9999' }).page).toBe(1000);
  });
});
