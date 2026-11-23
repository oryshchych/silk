import { describe, expect, it } from 'vitest';

import { isSearchPath } from './search-path';

describe('isSearchPath', () => {
  it('matches the route however it is spelled', () => {
    for (const path of [
      '/search',
      '/en/search',
      '/uk/search',
      '/%73earch',
      '/%65n/search',
      '/en/%73earch',
      '/%65n/%73%65%61%72%63%68',
      '/search/',
      '/en/search//',
      '//search',
    ]) {
      expect(isSearchPath(path)).toBe(true);
    }
  });

  it('does not match other pages or malformed encodings', () => {
    for (const path of [
      '/',
      '/en',
      '/category/search',
      '/searching',
      '/search/x',
      '/Search',
      '/%zz',
      '/%E0%A4%A',
      '/en/category/bras',
    ]) {
      expect(isSearchPath(path)).toBe(false);
    }
  });
});
