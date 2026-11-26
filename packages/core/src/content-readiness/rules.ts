/**
 * The readiness RULES, pure: facts about one product or category (numbers read by one set-based
 * query, see `read.ts`) in, findings out. No database, no clock, no I/O, so every rule is a unit
 * test and the report cannot differ between the screen, the CLI and the tests.
 *
 * Severity: a `blocker` makes a product that is meant to be live not ready and fails the launch
 * gate; a `warning` is advice (a length outside the guide, a text copied between languages).
 */
import { CONTENT_BOUNDS, type ContentField } from '@store/shared/content-bounds';
import type {
  CategoryReadinessDto,
  ContentFieldName,
  FindingDto,
  ProductReadinessDto,
} from '@store/shared/dto/content-readiness';

type Locale = 'uk' | 'en';
const LOCALES: readonly Locale[] = ['uk', 'en'];

export const TEXT_FIELDS = [
  'name',
  'short_description',
  'description',
  'composition',
  'care',
  'meta_title',
  'meta_description',
] as const satisfies readonly ContentFieldName[];
export type TextField = (typeof TEXT_FIELDS)[number];

const BOUND_KEY: Record<TextField, ContentField> = {
  name: 'name',
  short_description: 'shortDescription',
  description: 'description',
  composition: 'composition',
  care: 'care',
  meta_title: 'metaTitle',
  meta_description: 'metaDescription',
};

/** A length outside the bound is a blocker only where the text is a search snippet (the meta fields). */
const BOUND_IS_BLOCKER: Record<TextField, boolean> = {
  name: false,
  short_description: false,
  description: false,
  composition: false,
  care: false,
  meta_title: true,
  meta_description: true,
};

/** Fields that must not be one text pasted into both languages. */
const COPY_CHECKED: readonly TextField[] = [
  'short_description',
  'description',
  'composition',
  'care',
  'meta_title',
  'meta_description',
];

export interface PhotoFacts {
  total: number;
  altMissingUk: number;
  altMissingEn: number;
  altLength: number;
  tooNarrow: number;
  aspect: number;
  renditionsMissing: number;
  urlUnsafe: number;
}

export interface ProductFacts {
  id: string;
  sku: string;
  slug: string;
  nameUk: string;
  nameEn: string;
  isActive: boolean;
  /** The storefront shows it now (the catalogue's own visibility rule). */
  live: boolean;
  published: boolean;
  categoryVisible: boolean;
  noindex: boolean;
  slugServable: boolean;
  brandLength: number;
  basePrice: number;
  /** Trimmed length of each text, `<field>_<locale>`; 0 when empty or null. */
  lengths: Readonly<Record<string, number>>;
  /** `<field>` is true when both languages hold the same non-empty text. */
  sameText: Readonly<Record<string, boolean>>;
  /** `<field>_<locale>`: how many products share this exact meta text (0 when empty). */
  sharedMeta: Readonly<Record<string, number>>;
  claimWording: boolean;
  photos: PhotoFacts;
  variants: { active: number; available: number; withoutGtin: number };
  attributeCount: number;
}

const finding = (
  code: FindingDto['code'],
  severity: FindingDto['severity'],
  field: FindingDto['field'] = null,
  locale: FindingDto['locale'] = null,
  count: number | null = null,
): FindingDto => ({ code, severity, field, locale, count });

export function evaluateProduct(facts: ProductFacts): FindingDto[] {
  const out: FindingDto[] = [];
  if (!facts.isActive) out.push(finding('inactive', 'warning'));
  if (facts.isActive && !facts.published) out.push(finding('unpublished', 'blocker'));
  if (facts.isActive && !facts.categoryVisible) out.push(finding('category_hidden', 'blocker'));
  if (!facts.slugServable) out.push(finding('slug_unservable', 'blocker'));
  if (facts.noindex) out.push(finding('noindex', 'warning'));
  if (facts.brandLength === 0) out.push(finding('brand_missing', 'blocker'));
  if (facts.basePrice <= 0) out.push(finding('price_missing', 'blocker'));

  if (facts.variants.active === 0) out.push(finding('no_active_variant', 'blocker'));
  else {
    if (facts.variants.available === 0) out.push(finding('no_stock', 'blocker'));
    if (facts.variants.withoutGtin > 0)
      out.push(finding('gtin_missing', 'warning', null, null, facts.variants.withoutGtin));
  }
  if (facts.attributeCount === 0) out.push(finding('no_attributes', 'warning'));

  for (const field of TEXT_FIELDS) {
    const bound = CONTENT_BOUNDS[BOUND_KEY[field]];
    for (const locale of LOCALES) {
      const length = facts.lengths[`${field}_${locale}`] ?? 0;
      if (length === 0) {
        out.push(finding('missing', 'blocker', field, locale));
        continue;
      }
      const severity = BOUND_IS_BLOCKER[field] ? 'blocker' : 'warning';
      if (length < bound.min) out.push(finding('too_short', severity, field, locale));
      if (length > bound.max) out.push(finding('too_long', severity, field, locale));
    }
  }
  for (const field of COPY_CHECKED) {
    if (facts.sameText[field] === true)
      out.push(finding('same_in_both_languages', 'warning', field));
  }
  for (const field of ['meta_title', 'meta_description'] as const) {
    for (const locale of LOCALES) {
      if ((facts.sharedMeta[`${field}_${locale}`] ?? 0) > 1)
        out.push(finding('duplicate_in_catalog', 'warning', field, locale));
    }
  }
  if (facts.claimWording) out.push(finding('claim_review', 'warning'));

  const photos = facts.photos;
  if (photos.total === 0) out.push(finding('no_photo', 'blocker'));
  if (photos.altMissingUk > 0)
    out.push(finding('photo_alt_missing', 'blocker', 'alt', 'uk', photos.altMissingUk));
  if (photos.altMissingEn > 0)
    out.push(finding('photo_alt_missing', 'blocker', 'alt', 'en', photos.altMissingEn));
  if (photos.altLength > 0)
    out.push(finding('photo_alt_length', 'warning', 'alt', null, photos.altLength));
  if (photos.tooNarrow > 0)
    out.push(finding('photo_too_narrow', 'warning', null, null, photos.tooNarrow));
  if (photos.aspect > 0) out.push(finding('photo_aspect', 'warning', null, null, photos.aspect));
  if (photos.renditionsMissing > 0)
    out.push(finding('photo_renditions_missing', 'blocker', null, null, photos.renditionsMissing));
  if (photos.urlUnsafe > 0)
    out.push(finding('photo_url_unsafe', 'blocker', null, null, photos.urlUnsafe));
  return out;
}

export const hasBlocker = (findings: readonly FindingDto[]): boolean =>
  findings.some((entry) => entry.severity === 'blocker');

export function toProductReadiness(facts: ProductFacts): ProductReadinessDto {
  const findings = evaluateProduct(facts);
  return {
    id: facts.id,
    sku: facts.sku,
    slug: facts.slug,
    nameUk: facts.nameUk,
    nameEn: facts.nameEn,
    isActive: facts.isActive,
    live: facts.live,
    ready: !hasBlocker(findings),
    photoCount: facts.photos.total,
    activeVariantCount: facts.variants.active,
    findings,
  };
}

export interface CategoryFacts {
  id: string;
  slug: string;
  nameUk: string;
  nameEn: string;
  isActive: boolean;
  /** Visible text length (tags and entities removed) of the SEO text. */
  seoTextLength: Readonly<Record<Locale, number>>;
  metaTitleLength: Readonly<Record<Locale, number>>;
  metaDescriptionLength: Readonly<Record<Locale, number>>;
}

export function toCategoryReadiness(facts: CategoryFacts): CategoryReadinessDto {
  const out: FindingDto[] = [];
  const bound = CONTENT_BOUNDS.seoText;
  for (const locale of LOCALES) {
    const length = facts.seoTextLength[locale];
    if (length === 0) out.push(finding('missing', 'blocker', 'seo_text', locale));
    else if (length < bound.min) out.push(finding('too_short', 'warning', 'seo_text', locale));
    else if (length > bound.max) out.push(finding('too_long', 'warning', 'seo_text', locale));
    // The storefront falls back to the category name, so a missing meta is advice, not a blocker.
    if (facts.metaTitleLength[locale] === 0)
      out.push(finding('missing', 'warning', 'meta_title', locale));
    if (facts.metaDescriptionLength[locale] === 0)
      out.push(finding('missing', 'warning', 'meta_description', locale));
  }
  return {
    id: facts.id,
    slug: facts.slug,
    nameUk: facts.nameUk,
    nameEn: facts.nameEn,
    isActive: facts.isActive,
    seoTextLengthUk: facts.seoTextLength.uk,
    seoTextLengthEn: facts.seoTextLength.en,
    ready: !hasBlocker(out),
    findings: out,
  };
}
