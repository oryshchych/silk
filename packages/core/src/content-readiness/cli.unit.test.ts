import { describe, expect, it } from 'vitest';

import type { ContentReadinessDto } from '@store/shared/dto/content-readiness';

import { assertSafeTarget, formatSummary, plain, UnsafeTargetError } from './cli.ts';

describe('assertSafeTarget', () => {
  const local = { allowRemote: false };
  const remote = { allowRemote: true };
  it('accepts loopback, .local and bare service names by default', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'db.local', 'x.localhost', 'postgres'])
      expect(assertSafeTarget(`postgres://u:p@${host}:5432/store`, local)).toBeInstanceOf(URL);
  });
  it('refuses a remote host unless --allow-remote was given', () => {
    for (const host of [
      'staging-db.example.com',
      'abc.rds.amazonaws.com',
      '10.1.2.3',
      'db.internal.example',
    ]) {
      expect(() => assertSafeTarget(`postgres://u:p@${host}/store`, local)).toThrow(/not local/);
      expect(assertSafeTarget(`postgres://u:p@${host}/store`, remote)).toBeInstanceOf(URL);
    }
  });
  it('refuses anything that names production, even with --allow-remote', () => {
    for (const url of [
      'postgres://u:p@db.prod.example.com:5432/store',
      'postgres://u:p@prod-db:5432/store',
      'postgres://u:p@h:5432/store_production',
      'postgres://store_prod:p@h:5432/store',
      'postgres://u:p@PRD-db.internal/x',
      'postgres://u:p@db-live.internal/x',
      'postgres://u:p@localhost/prod',
      'postgres://u:p@localhost/prod_2',
    ]) {
      expect(() => assertSafeTarget(url, local)).toThrow(UnsafeTargetError);
      expect(() => assertSafeTarget(url, remote)).toThrow(/production/);
    }
  });
  it('refuses the parameters that redirect the driver to another host', () => {
    for (const query of [
      'host=prod.example.com',
      'hostaddr=10.0.0.1',
      'service=prod',
      'options=-c%20x=1',
    ])
      expect(() => assertSafeTarget(`postgres://u:p@localhost:1/x?${query}`, remote)).toThrow(
        /not accepted/,
      );
  });
  it('refuses a missing, malformed or non-postgres URL', () => {
    for (const bad of [undefined, '', 'not a url', 'mysql://u:p@h/db', 'https://example.com'])
      expect(() => assertSafeTarget(bad, remote)).toThrow(UnsafeTargetError);
  });
  it('does not mistake a word that merely contains prod', () => {
    expect(assertSafeTarget('postgres://u:p@localhost:5432/products', local)).toBeInstanceOf(URL);
    expect(assertSafeTarget('postgres://u:p@localhost:5432/lively', local)).toBeInstanceOf(URL);
  });
  it('never puts the credentials in the error message', () => {
    for (const url of [
      'postgres://admin:s3cret@prod-db:5432/store',
      'postgres://admin:s3cret@remote.example.com/store',
    ]) {
      try {
        assertSafeTarget(url, local);
      } catch (error) {
        expect(String(error)).not.toMatch(/s3cret|admin/);
      }
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
    expect(text).toContain('no photo');
    expect(text).not.toContain('\u001b');
  });
  it('lists advice with a plain-language gloss and counts, never raw codes alone', () => {
    const [first] = report().products;
    if (first === undefined) throw new Error('fixture');
    const withAdvice = report({
      products: [
        {
          ...first,
          findings: [
            { code: 'gtin_missing', severity: 'warning', field: null, locale: null, count: 2 },
            {
              code: 'same_in_both_languages',
              severity: 'warning',
              field: 'description',
              locale: null,
              count: null,
            },
          ],
        },
      ],
    });
    const text = formatSummary(withAdvice);
    expect(text).toContain('Advice (does not fail the gate)');
    expect(text).toContain('variants without a valid GTIN');
    expect(text).toContain('the same text in both languages');
  });
  it('says when the target is the default', () => {
    expect(formatSummary(report(), { defaultTarget: true, brief: true })).toContain('default');
  });
  it('brief mode lists no products', () => {
    expect(formatSummary(report(), { brief: true })).not.toContain('Active products with blockers');
  });
  it('says PASS when the gate passed', () => {
    expect(formatSummary(report({ gatePassed: true }), { brief: true })).toContain('GATE: PASS');
  });
});
