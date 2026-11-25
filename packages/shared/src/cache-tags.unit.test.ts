import { describe, expect, it } from 'vitest';

import { categoryTag, CATEGORIES_TAG, listingTag, productTag, SHOWCASE_TAG } from './cache-tags';

describe('cache tags', () => {
  it('use the product:{id} and category:{id} format of ADR-8', () => {
    expect(productTag('abc')).toBe('product:abc');
    expect(categoryTag('abc')).toBe('category:abc');
    expect(CATEGORIES_TAG).toBe('categories');
    expect(SHOWCASE_TAG).toBe('showcase');
  });

  it('keeps the listing tag apart from the breadcrumb tag of a product page', () => {
    expect(listingTag('abc')).toBe('listing:abc');
    expect(listingTag('abc')).not.toBe(categoryTag('abc'));
  });
});
