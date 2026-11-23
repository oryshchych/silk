import { describe, expect, it } from 'vitest';

import { buildAlternates } from '@store/shared/seo';

import { pageMetadata } from './metadata';

const alternates = buildAlternates({
  siteUrl: 'https://shop.example',
  locale: 'uk',
  path: '/search',
});
const base = {
  title: 'Search | Shop',
  description: null,
  locale: 'uk' as const,
  siteName: 'Shop',
  alternates,
};

describe('pageMetadata', () => {
  it('marks a page that must not be indexed (search results) noindex, follow, with a bare canonical', () => {
    const metadata = pageMetadata({ ...base, index: false });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('https://shop.example/search');
    expect(metadata.alternates?.languages).toMatchObject({ en: 'https://shop.example/en/search' });
  });

  it('marks an indexable page index, follow', () => {
    expect(pageMetadata({ ...base, index: true }).robots).toEqual({ index: true, follow: true });
  });

  it('carries title and canonical into Open Graph and a summary card without an image', () => {
    const metadata = pageMetadata({ ...base, index: true });
    expect(metadata.openGraph).toMatchObject({
      title: 'Search | Shop',
      url: 'https://shop.example/search',
    });
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
  });
});
