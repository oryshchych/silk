import { describe, expect, it } from 'vitest';

import type { LegalNavDto } from '@store/shared/dto/legal';

import { legalAlternates, publishedInBoth } from './legal-seo';

const row = (kind: LegalNavDto['kind'], locale: LegalNavDto['locale']): LegalNavDto => ({
  kind,
  locale,
  title: 't',
  version: '1',
  effectiveFrom: '2026-01-01T00:00:00Z',
});

describe('legal page alternates', () => {
  const both = [row('about', 'uk'), row('about', 'en'), row('faq', 'uk')];

  it('write the full pair when both languages are published', () => {
    const out = legalAlternates({
      siteUrl: 'https://s.example',
      locale: 'uk',
      kind: 'about',
      nav: both,
    });
    expect(out.canonical).toBe('https://s.example/legal/about');
    expect(out.languages).toEqual({
      uk: 'https://s.example/legal/about',
      en: 'https://s.example/en/legal/about',
      'x-default': 'https://s.example/legal/about',
    });
  });

  it('write a self canonical and NO alternates for a page published in one language only', () => {
    const out = legalAlternates({
      siteUrl: 'https://s.example',
      locale: 'uk',
      kind: 'faq',
      nav: both,
    });
    expect(out).toEqual({ canonical: 'https://s.example/legal/faq' });
    expect('languages' in out).toBe(false);
    expect(publishedInBoth(both, 'faq')).toBe(false);
    expect(publishedInBoth(both, 'terms')).toBe(false);
  });

  it('use the locale-prefixed canonical for English', () => {
    expect(
      legalAlternates({ siteUrl: 'https://s.example', locale: 'en', kind: 'about', nav: both })
        .canonical,
    ).toBe('https://s.example/en/legal/about');
  });
});
