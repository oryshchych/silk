/**
 * The readiness rules without a database: one overridden fact per failure class.
 */
import { describe, expect, it } from 'vitest';

import { CONTENT_BOUNDS } from '@store/shared/content-bounds';
import { contentReadinessDto, findingDto } from '@store/shared/dto/content-readiness';

import {
  evaluateProduct,
  hasBlocker,
  TEXT_FIELDS,
  toCategoryReadiness,
  toProductReadiness,
  type ProductFacts,
} from './rules.ts';

const goodLengths: Record<string, number> = {};
for (const field of TEXT_FIELDS) {
  const bound =
    CONTENT_BOUNDS[
      field === 'short_description'
        ? 'shortDescription'
        : field === 'meta_title'
          ? 'metaTitle'
          : field === 'meta_description'
            ? 'metaDescription'
            : field
    ];
  for (const locale of ['uk', 'en']) goodLengths[`${field}_${locale}`] = bound.min + 5;
}

function facts(over: Partial<ProductFacts> = {}): ProductFacts {
  return {
    id: '0193f0a4-7c3e-7000-8000-000000000001',
    sku: 'SKU-1',
    slug: 'item-1',
    nameUk: 'Назва',
    nameEn: 'Name',
    isActive: true,
    live: true,
    published: true,
    categoryVisible: true,
    noindex: false,
    slugServable: true,
    brandLength: 5,
    basePrice: 100_00,
    lengths: goodLengths,
    sameText: {},
    sharedMeta: {},
    claimWording: false,
    photos: {
      total: 2,
      altMissingUk: 0,
      altMissingEn: 0,
      altTooShort: 0,
      altTooLong: 0,
      tooNarrow: 0,
      aspect: 0,
      renditionsMissing: 0,
      urlUnsafe: 0,
    },
    variants: { active: 2, available: 2, withoutGtin: 0, skuTooLong: 0 },
    attributeCount: 3,
    ...over,
  };
}

const blockers = (over: Partial<ProductFacts>): string[] =>
  evaluateProduct(facts(over))
    .filter((f) => f.severity === 'blocker')
    .map((f) => [f.code, f.field, f.locale].filter((x) => x !== null).join(':'));

describe('evaluateProduct', () => {
  it('a complete product has no finding at all', () => {
    expect(evaluateProduct(facts())).toEqual([]);
  });
  it('every text is required in BOTH languages', () => {
    for (const field of TEXT_FIELDS)
      for (const locale of ['uk', 'en'])
        expect(blockers({ lengths: { ...goodLengths, [`${field}_${locale}`]: 0 } })).toEqual([
          `missing:${field}:${locale}`,
        ]);
  });
  it('a meta text outside its bound blocks, a body text outside its bound only warns', () => {
    const over = { ...goodLengths, meta_description_uk: CONTENT_BOUNDS.metaDescription.max + 1 };
    expect(blockers({ lengths: over })).toEqual(['too_long:meta_description:uk']);
    const under = { ...goodLengths, meta_title_en: CONTENT_BOUNDS.metaTitle.min - 1 };
    expect(blockers({ lengths: under })).toEqual(['too_short:meta_title:en']);
    const body = { ...goodLengths, description_uk: CONTENT_BOUNDS.description.min - 1 };
    expect(blockers({ lengths: body })).toEqual([]);
    expect(evaluateProduct(facts({ lengths: body }))[0]).toMatchObject({
      code: 'too_short',
      severity: 'warning',
    });
  });
  it('the bounds are inclusive', () => {
    const edge = {
      ...goodLengths,
      meta_description_uk: CONTENT_BOUNDS.metaDescription.max,
      meta_description_en: CONTENT_BOUNDS.metaDescription.min,
    };
    expect(evaluateProduct(facts({ lengths: edge }))).toEqual([]);
  });
  it('alt in one language only names that language and the count', () => {
    const only = facts({ photos: { ...facts().photos, altMissingEn: 2 } });
    expect(evaluateProduct(only)).toEqual([
      { code: 'photo_alt_missing', severity: 'blocker', field: 'alt', locale: 'en', count: 2 },
    ]);
  });
  it('state: draft informs, an active product not published or in a hidden category blocks', () => {
    expect(evaluateProduct(facts({ isActive: false, live: false, published: false }))).toEqual([
      { code: 'inactive', severity: 'warning', field: null, locale: null, count: null },
    ]);
    expect(blockers({ live: false, published: false })).toEqual(['unpublished']);
    expect(blockers({ live: false, categoryVisible: false })).toEqual(['category_hidden']);
  });
  it('variants and stock', () => {
    expect(
      blockers({ variants: { active: 0, available: 0, withoutGtin: 0, skuTooLong: 0 } }),
    ).toEqual(['no_active_variant']);
    expect(
      blockers({ variants: { active: 2, available: 0, withoutGtin: 0, skuTooLong: 0 } }),
    ).toEqual(['no_stock']);
  });
  it('photos: none, a missing rendition and an unsafe URL block; size and shape warn', () => {
    expect(blockers({ photos: { ...facts().photos, total: 0 } })).toEqual(['no_photo']);
    expect(blockers({ photos: { ...facts().photos, renditionsMissing: 1 } })).toEqual([
      'photo_renditions_missing',
    ]);
    expect(blockers({ photos: { ...facts().photos, urlUnsafe: 1 } })).toEqual(['photo_url_unsafe']);
    expect(
      blockers({
        photos: { ...facts().photos, tooNarrow: 1, aspect: 1, altTooLong: 1 },
      }),
    ).toEqual([]);
  });
  it('a product excluded from search blocks when it is meant to be sold, only informs as a draft', () => {
    expect(blockers({ noindex: true })).toEqual(['noindex']);
    expect(blockers({ noindex: true, isActive: false, live: false })).toEqual([]);
  });
  it('alt text too short to be real blocks; too long only warns', () => {
    expect(blockers({ photos: { ...facts().photos, altTooShort: 1 } })).toEqual([
      'photo_alt_too_short:alt',
    ]);
    expect(blockers({ photos: { ...facts().photos, altTooLong: 1 } })).toEqual([]);
  });
  it('the same meta text in both languages blocks, a copied body text only warns', () => {
    expect(blockers({ sameText: { meta_description: true } })).toEqual([
      'same_in_both_languages:meta_description',
    ]);
    expect(blockers({ sameText: { description: true } })).toEqual([]);
  });
  it('a variant SKU over the feed limit blocks', () => {
    expect(
      blockers({ variants: { active: 1, available: 1, withoutGtin: 0, skuTooLong: 1 } }),
    ).toEqual(['variant_sku_too_long']);
  });
  it('slug, brand and price', () => {
    expect(blockers({ slugServable: false })).toEqual(['slug_unservable']);
    expect(blockers({ brandLength: 0 })).toEqual(['brand_missing']);
    expect(blockers({ basePrice: 0 })).toEqual(['price_missing']);
  });
  it('advice never blocks', () => {
    const advice = facts({
      claimWording: true,
      attributeCount: 0,
      sameText: { description: true },
      sharedMeta: { meta_title_uk: 2 },
      variants: { active: 1, available: 1, withoutGtin: 1, skuTooLong: 0 },
    });
    expect(hasBlocker(evaluateProduct(advice))).toBe(false);
    expect(
      evaluateProduct(advice)
        .map((f) => f.code)
        .sort(),
    ).toEqual([
      'claim_review',
      'duplicate_in_catalog',
      'gtin_missing',
      'no_attributes',
      'same_in_both_languages',
    ]);
  });
  it('every finding validates against the DTO schema', () => {
    const all = evaluateProduct(
      facts({
        isActive: false,
        live: false,
        lengths: { ...goodLengths, meta_title_uk: 0 },
        photos: {
          total: 0,
          altMissingUk: 1,
          altMissingEn: 1,
          altTooShort: 1,
          altTooLong: 1,
          tooNarrow: 1,
          aspect: 1,
          renditionsMissing: 1,
          urlUnsafe: 1,
        },
      }),
    );
    for (const entry of all) expect(findingDto.safeParse(entry).success).toBe(true);
  });
});

describe('toProductReadiness and the DTO', () => {
  it('carries no cost field of any kind', () => {
    const json = JSON.stringify(toProductReadiness(facts()));
    expect(json).not.toMatch(/cost|price|margin/i);
  });
  it('the report schema has no cost key in any shape', () => {
    expect(JSON.stringify(contentReadinessDto.shape)).not.toMatch(/cost/i);
    const keys = Object.keys(contentReadinessDto.shape);
    expect(keys).not.toContain('costPrice');
  });
});

describe('toCategoryReadiness', () => {
  const base = {
    id: '0193f0a4-7c3e-7000-8000-000000000002',
    slug: 'bras',
    nameUk: 'Бюстгальтери',
    nameEn: 'Bras',
    isActive: true,
    noindex: false,
    liveProducts: 3,
    seoTextLength: { uk: 400, en: 400 },
    metaTitleLength: { uk: 30, en: 30 },
    metaDescriptionLength: { uk: 100, en: 100 },
  } as const;
  it('ready with both texts', () => {
    expect(toCategoryReadiness(base)).toMatchObject({ ready: true, findings: [] });
  });
  it('a text in one language only blocks that language', () => {
    const one = toCategoryReadiness({ ...base, seoTextLength: { uk: 400, en: 0 } });
    expect(one.ready).toBe(false);
    expect(one.findings).toEqual([
      { code: 'missing', severity: 'blocker', field: 'seo_text', locale: 'en', count: null },
    ]);
  });
  it('a text under its bound blocks, over it and a missing meta only warn', () => {
    const under = toCategoryReadiness({
      ...base,
      seoTextLength: { uk: CONTENT_BOUNDS.seoText.min - 1, en: 400 },
    });
    expect(under.ready).toBe(false);
    const over = toCategoryReadiness({
      ...base,
      seoTextLength: { uk: 400, en: CONTENT_BOUNDS.seoText.max + 1 },
      metaTitleLength: { uk: 0, en: 30 },
    });
    expect(over.ready).toBe(true);
    expect(over.findings.map((f) => f.code).sort()).toEqual(['missing', 'too_long']);
  });
  it('an indexable category with no live products blocks; a noindex one needs neither text nor products', () => {
    expect(toCategoryReadiness({ ...base, liveProducts: 0 }).findings).toEqual([
      { code: 'no_products', severity: 'blocker', field: null, locale: null, count: null },
    ]);
    const hidden = toCategoryReadiness({
      ...base,
      noindex: true,
      liveProducts: 0,
      seoTextLength: { uk: 0, en: 0 },
    });
    expect(hidden.ready).toBe(true);
    expect(hidden.findings.every((f) => f.severity === 'warning')).toBe(true);
  });
  it('an inactive category is not asked for products', () => {
    expect(toCategoryReadiness({ ...base, isActive: false, liveProducts: 0 }).findings).toEqual([]);
  });
});
