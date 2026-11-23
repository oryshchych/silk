import { describe, expect, it } from 'vitest';

import { missingPath, parseProductPath } from './product-path';

describe('parseProductPath', () => {
  it('reads the locale and slug of a product URL', () => {
    expect(parseProductPath('/product/aurora-1')).toEqual({ locale: 'uk', slug: 'aurora-1' });
    expect(parseProductPath('/en/product/aurora-1')).toEqual({ locale: 'en', slug: 'aurora-1' });
  });

  it('keeps an encoded or odd slug as sent, for the shape check to reject', () => {
    expect(parseProductPath('/product/x%00abc')?.slug).toBe('x%00abc');
  });

  it('ignores every other path', () => {
    for (const path of [
      '/',
      '/product',
      '/product/',
      '/product/a/b',
      '/category/bras',
      '/en/category/product/x',
      '/uk/product/a',
    ]) {
      expect(parseProductPath(path)).toBeNull();
    }
  });

  it('builds an unmatched path per locale', () => {
    expect(missingPath('uk')).toBe('/uk/__missing__/product');
    expect(missingPath('en')).toBe('/en/__missing__/product');
  });
});
