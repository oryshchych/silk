import { describe, expect, it } from 'vitest';

import {
  escapeXml,
  parseSitemapName,
  productFileCount,
  SITEMAP_PRODUCTS_PER_FILE,
  SITEMAP_URL_LIMIT,
  sitemapIndexXml,
  urlEntries,
} from './sitemap-xml';

describe('sitemap xml', () => {
  it('escapes every XML special character in a slug', () => {
    expect(escapeXml(`a&b<c>"d"'e'`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
    const xml = urlEntries('https://s.example', { path: '/product/a&b', lastmod: null });
    expect(xml).not.toContain('a&b');
    expect(xml).toContain('a&amp;b');
  });

  it('writes both locales, each listing the full hreflang set', () => {
    const xml = urlEntries('https://s.example', {
      path: '/category/bras',
      lastmod: '2026-11-26T10:00:00Z',
    });
    expect(xml.match(/<url>/g)).toHaveLength(2);
    expect(xml).toContain('<loc>https://s.example/category/bras</loc>');
    expect(xml).toContain('<loc>https://s.example/en/category/bras</loc>');
    expect(xml.match(/hreflang="uk" href="https:\/\/s\.example\/category\/bras"/g)).toHaveLength(2);
    expect(
      xml.match(/hreflang="en" href="https:\/\/s\.example\/en\/category\/bras"/g),
    ).toHaveLength(2);
    expect(
      xml.match(/hreflang="x-default" href="https:\/\/s\.example\/category\/bras"/g),
    ).toHaveLength(2);
    expect(xml).toContain('<lastmod>2026-11-26T10:00:00Z</lastmod>');
  });

  it('writes the home page without a trailing slash', () => {
    const xml = urlEntries('https://s.example', { path: '/', lastmod: null });
    expect(xml).toContain('<loc>https://s.example</loc>');
    expect(xml).toContain('<loc>https://s.example/en</loc>');
    expect(xml).not.toContain('s.example/<');
  });

  it('drops a lastmod that is not a UTC date-time', () => {
    const xml = urlEntries('https://s.example', { path: '/', lastmod: '</lastmod><evil/>' });
    expect(xml).not.toContain('lastmod');
  });

  it('keeps a file within 50 000 URLs', () => {
    expect(SITEMAP_PRODUCTS_PER_FILE * 2).toBeLessThanOrEqual(SITEMAP_URL_LIMIT);
    expect(productFileCount(0)).toBe(1);
    expect(productFileCount(SITEMAP_PRODUCTS_PER_FILE)).toBe(1);
    expect(productFileCount(SITEMAP_PRODUCTS_PER_FILE + 1)).toBe(2);
  });

  it('accepts only names of real files, in one canonical spelling', () => {
    expect(parseSitemapName('pages.xml', 1)).toEqual({ kind: 'pages' });
    expect(parseSitemapName('products-0.xml', 1)).toEqual({ kind: 'products', index: 0 });
    for (const bad of [
      'products-1.xml',
      'products-00.xml',
      'products-01.xml',
      'products--1.xml',
      'products-0.XML',
      'Products-0.xml',
      'products-0.xml/',
      'products-9999999.xml',
      '..%2Fpages.xml',
      'pages.xml ',
    ]) {
      expect(parseSitemapName(bad, 1)).toBeNull();
    }
  });

  it('builds the index', () => {
    expect(sitemapIndexXml(['https://s.example/a&b.xml'])).toContain(
      '<loc>https://s.example/a&amp;b.xml</loc>',
    );
  });
});
