import { describe, expect, it } from 'vitest';

import type { ContentReadinessDto } from '@store/shared/dto/content-readiness';

import { assertSafeTarget, formatSummary, plain, UnsafeTargetError } from './cli.ts';

describe('assertSafeTarget', () => {
  it('accepts a local or staging database outside production', () => {
    expect(assertSafeTarget('postgres://u:p@localhost:5432/store', undefined).hostname).toBe(
      'localhost',
    );
    expect(
      assertSafeTarget('postgresql://u:p@staging-db:5432/store_staging', 'staging'),
    ).toBeInstanceOf(URL);
  });
  it('refuses a missing, malformed or non-postgres URL', () => {
    for (const bad of [undefined, '', 'not a url', 'mysql://u:p@h/db', 'https://example.com'])
      expect(() => assertSafeTarget(bad, undefined)).toThrow(UnsafeTargetError);
  });
  it('refuses anything that looks like production unless the process is production', () => {
    for (const url of [
      'postgres://u:p@db.prod.example.com:5432/store',
      'postgres://u:p@prod-db:5432/store',
      'postgres://u:p@h:5432/store_production',
      'postgres://store_prod:p@h:5432/store',
      'postgres://u:p@h:5432/prod',
    ]) {
      expect(() => assertSafeTarget(url, undefined)).toThrow(/production/);
      expect(() => assertSafeTarget(url, 'local')).toThrow(/production/);
      expect(assertSafeTarget(url, 'production')).toBeInstanceOf(URL);
    }
  });
  it('does not mistake a word that merely contains prod', () => {
    expect(assertSafeTarget('postgres://u:p@h:5432/products', undefined)).toBeInstanceOf(URL);
  });
  it('never puts the credentials in the error message', () => {
    try {
      assertSafeTarget('postgres://admin:s3cret@prod-db:5432/store', undefined);
    } catch (error) {
      expect(String(error)).not.toMatch(/s3cret|admin/);
    }
  });
});

describe('plain', () => {
  it('removes escape sequences and line breaks from staff input', () => {
    expect(plain('a\u001b[31mred\u001b[0m\nb\r')).toBe('a?[31mred?[0m?b?');
  });
});

const report = (over: Partial<ContentReadinessDto> = {}): ContentReadinessDto => ({
  generatedAt: '2026-11-27T10:00:00.000Z',
  expectedActive: 40,
  totals: {
    products: 2,
    live: 1,
    liveReady: 1,
    active: 2,
    activeReady: 1,
    drafts: 0,
    draftsReady: 0,
    categories: 1,
    categoriesReady: 0,
    photos: 3,
    photosWithProblems: 1,
  },
  acceptance: [{ id: 'active_products', ok: false, actual: 1, expected: 40 }],
  gatePassed: false,
  products: [
    {
      id: '0193f0a4-7c3e-7000-8000-000000000001',
      sku: 'A\u001b[2Jx',
      slug: 'a',
      nameUk: 'А',
      nameEn: 'A',
      isActive: true,
      live: false,
      ready: false,
      photoCount: 0,
      activeVariantCount: 0,
      findings: [{ code: 'no_photo', severity: 'blocker', field: null, locale: null, count: null }],
    },
  ],
  productsTruncated: false,
  categories: [],
  photoProblems: [],
  photoProblemsTruncated: false,
  ...over,
});

describe('formatSummary', () => {
  it('states the verdict, the counts and the blockers; escapes terminal control characters', () => {
    const text = formatSummary(report());
    expect(text).toContain('1 of 40 live products ready');
    expect(text).toContain('GATE: FAIL');
    expect(text).toContain('no_photo');
    expect(text).not.toContain('\u001b');
  });
  it('brief mode lists no products', () => {
    expect(formatSummary(report(), { brief: true })).not.toContain('Active products with blockers');
  });
  it('says PASS when the gate passed', () => {
    expect(formatSummary(report({ gatePassed: true }), { brief: true })).toContain('GATE: PASS');
  });
});
