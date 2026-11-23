import { describe, expect, it } from 'vitest';

import { categoryTag, CATEGORIES_TAG, productTag } from './cache-tags';

describe('cache tags', () => {
  it('use the product:{id} and category:{id} format of ADR-8', () => {
    expect(productTag('abc')).toBe('product:abc');
    expect(categoryTag('abc')).toBe('category:abc');
    expect(CATEGORIES_TAG).toBe('categories');
  });
});
