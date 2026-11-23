import { describe, expect, it } from 'vitest';

import { buildAlternates, localizedPath, resolveSiteUrl } from './seo';

describe('resolveSiteUrl', () => {
  it('prefers the runtime SITE_URL over the build-time value', () => {
    expect(
      resolveSiteUrl({
        SITE_URL: 'https://shop.example/',
        NEXT_PUBLIC_SITE_URL: 'https://old.example',
      }),
    ).toBe('https://shop.example');
  });

  it('falls back to the build-time value, then to localhost', () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: 'https://old.example/x' })).toBe(
      'https://old.example',
    );
    expect(resolveSiteUrl({})).toBe('http://localhost:3000');
  });

  it('throws on a value that is not a URL', () => {
    expect(() => resolveSiteUrl({ SITE_URL: 'not a url' })).toThrow();
  });
});

describe('localizedPath', () => {
  it('leaves the default locale unprefixed and prefixes the others', () => {
    expect(localizedPath('uk', '/')).toBe('/');
    expect(localizedPath('uk', '/category/bras')).toBe('/category/bras');
    expect(localizedPath('en', '/')).toBe('/en');
    expect(localizedPath('en', '/category/bras')).toBe('/en/category/bras');
  });
});

describe('buildAlternates', () => {
  const siteUrl = 'https://shop.example';

  it('produces reciprocal absolute pairs and x-default for the uk page', () => {
    const a = buildAlternates({ siteUrl, locale: 'uk', path: '/category/bras' });
    expect(a.canonical).toBe('https://shop.example/category/bras');
    expect(a.languages).toEqual({
      uk: 'https://shop.example/category/bras',
      en: 'https://shop.example/en/category/bras',
      'x-default': 'https://shop.example/category/bras',
    });
  });

  it('gives the same language set for the en page, with its own canonical', () => {
    const uk = buildAlternates({ siteUrl, locale: 'uk', path: '/' });
    const en = buildAlternates({ siteUrl, locale: 'en', path: '/' });
    expect(en.canonical).toBe('https://shop.example/en');
    expect(en.languages).toEqual(uk.languages);
  });

  it('keeps the query on every URL so a language switch preserves filters', () => {
    const a = buildAlternates({ siteUrl, locale: 'en', path: '/category/bras', search: 'band=75' });
    expect(a.canonical).toBe('https://shop.example/en/category/bras?band=75');
    expect(a.languages.uk).toBe('https://shop.example/category/bras?band=75');
  });
});
