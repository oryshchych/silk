import { describe, expect, it } from 'vitest';

import {
  escapeXml,
  parseSitemapName,
  productFileCount,
  SITEMAP_PRODUCTS_PER_FILE,
  SITEMAP_BYTE_LIMIT,
  SITEMAP_URL_LIMIT,
  isSitemapFileName,
  slugPath,
  SITEMAP_SLUG,
  sitemapIndexXml,
  legalUrlEntries,
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
    // The byte limit decides with the longest slugs the schema allows (200 characters).
    const worst = urlEntries('https://shop.example', {
      path: slugPath('product', 'a'.repeat(200)),
      lastmod: '2026-11-26T10:00:00Z',
    });
    expect(Buffer.byteLength(worst) * SITEMAP_PRODUCTS_PER_FILE).toBeLessThan(SITEMAP_BYTE_LIMIT);
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

  it('percent-encodes a slug so it cannot change the URL, and the slug shape is the proxy one', () => {
    const path = slugPath('product', 'a?b#c%d/e');
    expect(path).toBe('/product/a%3Fb%23c%25d%2Fe');
    const xml = urlEntries('https://s.example', { path, lastmod: null });
    expect(xml).not.toContain('a?b');
    expect(xml.match(/<url>/g)).toHaveLength(2);
    for (const bad of ['бюстгальтер', "o'neil", 'a&b', 'a?b#c', 'A-b', '-a', 'a--b', '']) {
      expect(SITEMAP_SLUG.test(bad), bad).toBe(false);
    }
    expect(SITEMAP_SLUG.test('push-up-bra-2')).toBe(true);
  });

  it('checks a file name by syntax alone', () => {
    expect(isSitemapFileName('pages.xml')).toBe(true);
    expect(isSitemapFileName('products-123456.xml')).toBe(true);
    for (const bad of ['x.xml', 'PAGES.xml', 'products-1234567.xml', 'products-01.xml', '']) {
      expect(isSitemapFileName(bad), bad).toBe(false);
    }
  });

  it('builds the index', () => {
    expect(sitemapIndexXml(['https://s.example/a&b.xml'])).toContain(
      '<loc>https://s.example/a&amp;b.xml</loc>',
    );
  });
});

describe('legalUrlEntries: hreflang only where both locales exist', () => {
  const stamp = '2026-11-20T10:00:00Z';

  it('lists the whole pair on each url when both locales are published', () => {
    const xml = legalUrlEntries('https://shop.example', '/legal/terms', [
      { locale: 'uk', lastmod: stamp },
      { locale: 'en', lastmod: stamp },
    ]);
    expect(xml.match(/<url>/g)).toHaveLength(2);
    expect(xml).toContain('<loc>https://shop.example/legal/terms</loc>');
    expect(xml).toContain('<loc>https://shop.example/en/legal/terms</loc>');
    expect(xml.match(/hreflang="en"/g)).toHaveLength(2);
    expect(xml).toContain('<lastmod>2026-11-20T10:00:00Z</lastmod>');
  });

  it('writes no alternate at all for a page that has only one locale', () => {
    const xml = legalUrlEntries('https://shop.example', '/legal/faq', [
      { locale: 'en', lastmod: stamp },
    ]);
    expect(xml).toContain('<loc>https://shop.example/en/legal/faq</loc>');
    expect(xml).not.toContain('hreflang');
    expect(xml).not.toContain('/legal/faq</loc>\n<url>');
  });

  it('drops a malformed lastmod instead of writing it', () => {
    expect(
      legalUrlEntries('https://shop.example', '/legal/terms', [
        { locale: 'uk', lastmod: 'yesterday' },
      ]),
    ).not.toContain('lastmod');
  });
});
