/**
 * The content readiness report from the database: a constant number of set-based queries however
 * many products there are (products with their photo, variant and attribute aggregates; categories;
 * photo totals; the first problem photos). Read only: the function takes a `Reader`, so the caller
 * may hand it a read-only transaction (the CLI does).
 *
 * Nothing here selects a cost column: the DTO has no such field for any role.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import {
  CLAIM_PATTERN,
  CONTENT_BOUNDS,
  FEED_MAX_ID_LENGTH,
  PHOTO_BOUNDS,
} from '@store/shared/content-bounds';
import type { PhotoProblemDto } from '@store/shared/dto/content-readiness';

import { IMAGE_FORMATS, IMAGE_SIZES } from '../catalog-admin/images.ts';
import { queryRows, visibleProduct } from '../catalog/sql.ts';
import { TEXT_FIELDS, type CategoryFacts, type ProductFacts } from './rules.ts';

export const REPORT_PHOTO_LIMIT = 500;

const LOCALES = ['uk', 'en'] as const;
const COLUMN: Record<(typeof TEXT_FIELDS)[number], string> = {
  name: 'name',
  short_description: 'short_description',
  description: 'description',
  composition: 'composition',
  care: 'care',
  meta_title: 'meta_title',
  meta_description: 'meta_description',
};

/**
 * The text a visitor can read: zero-width characters removed, every run of blanks (NBSP and the
 * line separators included) one space, trimmed. `btrim` alone strips only ASCII spaces, so a text of
 * U+200B or a lone NBSP would count as content.
 */
const norm = (column: string): string =>
  `btrim(regexp_replace(regexp_replace(coalesce(${column}, ''), '[\\u200b-\\u200d\\u2060\\ufeff]', '', 'g'), '[[:space:]\\u00a0\\u2028\\u2029]+', ' ', 'g'))`;

/** Visible length of a nullable text column. */
const len = (column: string): string => `char_length(${norm(column)})`;

/** Same non-empty text in both languages (case and surrounding blanks ignored). */
const sameText = (field: string): string =>
  `coalesce(${len(`p.${field}_uk`)} > 0 AND lower(${norm(`p.${field}_uk`)}) = lower(${norm(`p.${field}_en`)}), false)`;

const LENGTHS_SQL = TEXT_FIELDS.flatMap((field) =>
  LOCALES.map((locale) => `'${field}_${locale}', ${len(`p.${COLUMN[field]}_${locale}`)}`),
).join(', ');

const SAME_SQL = TEXT_FIELDS.filter((field) => field !== 'name')
  .map((field) => `'${field}', ${sameText(COLUMN[field])}`)
  .join(', ');

const sharedMeta = (field: string, locale: string): string =>
  `CASE WHEN ${len(`p.${field}_${locale}`)} = 0 THEN 0
        ELSE count(*) OVER (PARTITION BY lower(${norm(`p.${field}_${locale}`)})) END`;
const SHARED_SQL = (['meta_title', 'meta_description'] as const)
  .flatMap((field) => LOCALES.map((locale) => `'${field}_${locale}', ${sharedMeta(field, locale)}`))
  .join(', ');

const CLAIM_COLUMNS = TEXT_FIELDS.filter((field) => field !== 'name')
  .flatMap((field) => LOCALES.map((locale) => `coalesce(p.${COLUMN[field]}_${locale}, '')`))
  .join(` || ' ' || `);

/** The same shape `safeMediaUrl` accepts: an https URL or a site-relative path, no blanks, quotes or control characters. */
export const URL_SAFE_PATTERN =
  '^(https://[^[:space:][:cntrl:]"\'<>`\\\\]+|/|/[^/[:space:][:cntrl:]"\'<>`\\\\][^[:space:][:cntrl:]"\'<>`\\\\]*)$';

/** Every rendition of the row's own ids is present in `variants`, and `url` is the main one (the upload route's contract). */
function renditionsCondition(): SQL {
  const parts = IMAGE_SIZES.flatMap((size) =>
    IMAGE_FORMATS.map(
      (format) =>
        sql`(i.variants ->> ${`${size}.${format}`}) LIKE ('%/products/' || i.product_id::text || '/' || i.id::text || ${`/${size}.${format}`})`,
    ),
  );
  return sql`(i.variants IS NOT NULL AND i.url = (i.variants ->> 'full.webp') AND ${sql.join(parts, sql` AND `)})`;
}

const altLen = (column: string): SQL => sql.raw(len(`i.${column}`));
/** Present but shorter than the bound: a placeholder (`.`, `x`) is not alt text. */
const altShort = (column: string): SQL =>
  sql`(${altLen(column)} > 0 AND ${altLen(column)} < ${CONTENT_BOUNDS.alt.min})`;
const altLong = (column: string): SQL => sql`(${altLen(column)} > ${CONTENT_BOUNDS.alt.max})`;

/** One flag per problem, per photo row. */
function imageFlags(): SQL {
  return sql`SELECT i.id, i.product_id, i.width, i.height,
      ${altLen('alt_uk')} = 0 AS alt_missing_uk,
      ${altLen('alt_en')} = 0 AS alt_missing_en,
      (${altShort('alt_uk')} OR ${altShort('alt_en')}) AS alt_too_short,
      (${altLong('alt_uk')} OR ${altLong('alt_en')}) AS alt_too_long,
      coalesce(i.width, 0) < ${PHOTO_BOUNDS.minWidth} AS too_narrow,
      (i.width IS NOT NULL AND i.height IS NOT NULL AND i.height > 0
        AND (i.width::numeric / i.height) NOT BETWEEN ${PHOTO_BOUNDS.aspectMin}::numeric AND ${PHOTO_BOUNDS.aspectMax}::numeric) AS aspect,
      NOT coalesce(${renditionsCondition()}, false) AS renditions_missing,
      NOT (btrim(i.url) ~ ${URL_SAFE_PATTERN}) AS url_unsafe
    FROM product_images i`;
}

const productRow = z.object({
  id: z.uuid(),
  sku: z.string(),
  slug: z.string(),
  name_uk: z.string(),
  name_en: z.string(),
  is_active: z.boolean(),
  live: z.boolean(),
  published: z.boolean(),
  category_visible: z.boolean(),
  noindex: z.boolean(),
  slug_servable: z.boolean(),
  brand_length: z.number().int(),
  base_price: z.number().int(),
  lengths: z.record(z.string(), z.number()),
  same_text: z.record(z.string(), z.boolean()),
  shared_meta: z.record(z.string(), z.number()),
  claim_wording: z.boolean(),
  photos: z.number().int(),
  alt_missing_uk: z.number().int(),
  alt_missing_en: z.number().int(),
  alt_too_short: z.number().int(),
  alt_too_long: z.number().int(),
  too_narrow: z.number().int(),
  aspect: z.number().int(),
  renditions_missing: z.number().int(),
  url_unsafe: z.number().int(),
  variants_active: z.number().int(),
  variants_available: z.number().int(),
  variants_without_gtin: z.number().int(),
  variants_sku_too_long: z.number().int(),
  attributes: z.number().int(),
});

export async function readProductFacts(db: Reader): Promise<ProductFacts[]> {
  const rows = await queryRows(
    db,
    productRow,
    sql`WITH img AS (${imageFlags()}),
         ia AS (
           SELECT product_id, count(*)::int AS photos,
                  (count(*) FILTER (WHERE alt_missing_uk))::int AS alt_missing_uk,
                  (count(*) FILTER (WHERE alt_missing_en))::int AS alt_missing_en,
                  (count(*) FILTER (WHERE alt_too_short))::int AS alt_too_short,
                  (count(*) FILTER (WHERE alt_too_long))::int AS alt_too_long,
                  (count(*) FILTER (WHERE too_narrow))::int AS too_narrow,
                  (count(*) FILTER (WHERE aspect))::int AS aspect,
                  (count(*) FILTER (WHERE renditions_missing))::int AS renditions_missing,
                  (count(*) FILTER (WHERE url_unsafe))::int AS url_unsafe
             FROM img GROUP BY product_id
         ),
         va AS (
           SELECT v.product_id,
                  (count(*) FILTER (WHERE v.is_active))::int AS active,
                  (count(*) FILTER (WHERE v.is_active AND v.stock_quantity - v.reserved_quantity > 0))::int AS available,
                  (count(*) FILTER (WHERE v.is_active
                     AND (v.barcode IS NULL OR v.barcode !~ '^([0-9]{8}|[0-9]{12,14})$')))::int AS without_gtin,
                  (count(*) FILTER (WHERE v.is_active
                     AND char_length(v.sku) > ${FEED_MAX_ID_LENGTH}))::int AS sku_too_long
             FROM product_variants v GROUP BY v.product_id
         ),
         pa AS (SELECT product_id, count(*)::int AS n FROM product_attribute_values GROUP BY product_id)
        SELECT p.id, p.sku, p.slug, p.name_uk, p.name_en, p.is_active, p.noindex,
               ${visibleProduct} AS live,
               (p.published_at IS NOT NULL AND p.published_at <= now()) AS published,
               EXISTS (
                 SELECT 1 FROM categories c0
                   LEFT JOIN categories c1 ON c1.id = c0.parent_id
                   LEFT JOIN categories c2 ON c2.id = c1.parent_id
                   LEFT JOIN categories c3 ON c3.id = c2.parent_id
                  WHERE c0.id = p.category_id AND c0.is_active
                    AND coalesce(c1.is_active, true) AND coalesce(c2.is_active, true)
                    AND coalesce(c3.is_active, true)
               ) AS category_visible,
               (p.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$') AS slug_servable,
               ${sql.raw(len('p.brand'))} AS brand_length,
               p.base_price,
               jsonb_build_object(${sql.raw(LENGTHS_SQL)}) AS lengths,
               jsonb_build_object(${sql.raw(SAME_SQL)}) AS same_text,
               jsonb_build_object(${sql.raw(SHARED_SQL)}) AS shared_meta,
               ((${sql.raw(CLAIM_COLUMNS)}) ~ ${CLAIM_PATTERN}) AS claim_wording,
               coalesce(ia.photos, 0) AS photos,
               coalesce(ia.alt_missing_uk, 0) AS alt_missing_uk,
               coalesce(ia.alt_missing_en, 0) AS alt_missing_en,
               coalesce(ia.alt_too_short, 0) AS alt_too_short,
               coalesce(ia.alt_too_long, 0) AS alt_too_long,
               coalesce(ia.too_narrow, 0) AS too_narrow,
               coalesce(ia.aspect, 0) AS aspect,
               coalesce(ia.renditions_missing, 0) AS renditions_missing,
               coalesce(ia.url_unsafe, 0) AS url_unsafe,
               coalesce(va.active, 0) AS variants_active,
               coalesce(va.available, 0) AS variants_available,
               coalesce(va.without_gtin, 0) AS variants_without_gtin,
               coalesce(va.sku_too_long, 0) AS variants_sku_too_long,
               coalesce(pa.n, 0) AS attributes
          FROM products p
          LEFT JOIN ia ON ia.product_id = p.id
          LEFT JOIN va ON va.product_id = p.id
          LEFT JOIN pa ON pa.product_id = p.id
         WHERE p.kind = 'physical'
         ORDER BY p.sku`,
  );
  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    slug: row.slug,
    nameUk: row.name_uk,
    nameEn: row.name_en,
    isActive: row.is_active,
    live: row.live,
    published: row.published,
    categoryVisible: row.category_visible,
    noindex: row.noindex,
    slugServable: row.slug_servable,
    brandLength: row.brand_length,
    basePrice: row.base_price,
    lengths: row.lengths,
    sameText: row.same_text,
    sharedMeta: row.shared_meta,
    claimWording: row.claim_wording,
    photos: {
      total: row.photos,
      altMissingUk: row.alt_missing_uk,
      altMissingEn: row.alt_missing_en,
      altTooShort: row.alt_too_short,
      altTooLong: row.alt_too_long,
      tooNarrow: row.too_narrow,
      aspect: row.aspect,
      renditionsMissing: row.renditions_missing,
      urlUnsafe: row.url_unsafe,
    },
    variants: {
      active: row.variants_active,
      available: row.variants_available,
      withoutGtin: row.variants_without_gtin,
      skuTooLong: row.variants_sku_too_long,
    },
    attributeCount: row.attributes,
  }));
}

/** Visible text length of rich text: tags and entities do not count, nor do invisible characters. */
const richLen = (column: string): string =>
  len(
    `regexp_replace(regexp_replace(coalesce(${column}, ''), '<[^>]*>', '', 'g'), '&[a-zA-Z#0-9]+;', ' ', 'g')`,
  );

const categoryRow = z.object({
  id: z.uuid(),
  slug: z.string(),
  name_uk: z.string(),
  name_en: z.string(),
  is_active: z.boolean(),
  noindex: z.boolean(),
  live_products: z.number().int(),
  seo_uk: z.number().int(),
  seo_en: z.number().int(),
  mt_uk: z.number().int(),
  mt_en: z.number().int(),
  md_uk: z.number().int(),
  md_en: z.number().int(),
});

export async function readCategoryFacts(db: Reader): Promise<CategoryFacts[]> {
  const rows = await queryRows(
    db,
    categoryRow,
    sql`WITH RECURSIVE sub(root_id, id) AS (
          SELECT id, id FROM categories
          UNION ALL
          SELECT sub.root_id, c.id FROM categories c JOIN sub ON c.parent_id = sub.id
        ),
        counts AS (
          SELECT sub.root_id, count(p.id)::int AS n
            FROM sub JOIN products p ON p.category_id = sub.id AND ${visibleProduct}
           GROUP BY sub.root_id
        )
        SELECT c.id, c.slug, c.name_uk, c.name_en, c.is_active, c.noindex, coalesce(counts.n, 0) AS live_products,
               ${sql.raw(richLen('c.seo_text_uk'))} AS seo_uk, ${sql.raw(richLen('c.seo_text_en'))} AS seo_en,
               ${sql.raw(len('c.meta_title_uk'))} AS mt_uk, ${sql.raw(len('c.meta_title_en'))} AS mt_en,
               ${sql.raw(len('c.meta_description_uk'))} AS md_uk, ${sql.raw(len('c.meta_description_en'))} AS md_en
          FROM categories c LEFT JOIN counts ON counts.root_id = c.id
         ORDER BY c.depth, c.sort_order, c.slug`,
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    nameUk: row.name_uk,
    nameEn: row.name_en,
    isActive: row.is_active,
    noindex: row.noindex,
    liveProducts: row.live_products,
    seoTextLength: { uk: row.seo_uk, en: row.seo_en },
    metaTitleLength: { uk: row.mt_uk, en: row.mt_en },
    metaDescriptionLength: { uk: row.md_uk, en: row.md_en },
  }));
}

const photoTotals = z.object({ total: z.number().int(), problems: z.number().int() });
const photoRow = z.object({
  id: z.uuid(),
  product_id: z.uuid(),
  sku: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  alt_missing_uk: z.boolean(),
  alt_missing_en: z.boolean(),
  alt_too_short: z.boolean(),
  alt_too_long: z.boolean(),
  too_narrow: z.boolean(),
  aspect: z.boolean(),
  renditions_missing: z.boolean(),
  url_unsafe: z.boolean(),
});
const ANY_PROBLEM = sql`(alt_missing_uk OR alt_missing_en OR alt_too_short OR alt_too_long OR too_narrow OR aspect
  OR renditions_missing OR url_unsafe)`;

export async function readPhotos(
  db: Reader,
): Promise<{ total: number; problems: number; list: PhotoProblemDto[]; truncated: boolean }> {
  const [totals] = await queryRows(
    db,
    photoTotals,
    sql`WITH img AS (${imageFlags()})
        SELECT count(*)::int AS total, (count(*) FILTER (WHERE ${ANY_PROBLEM}))::int AS problems FROM img`,
  );
  const rows = await queryRows(
    db,
    photoRow,
    sql`WITH img AS (${imageFlags()})
        SELECT img.id, img.product_id, p.sku, img.width, img.height, img.alt_missing_uk, img.alt_missing_en,
               img.alt_too_short, img.alt_too_long, img.too_narrow, img.aspect, img.renditions_missing, img.url_unsafe
          FROM img JOIN products p ON p.id = img.product_id
         WHERE ${ANY_PROBLEM}
         ORDER BY p.sku, img.id LIMIT ${REPORT_PHOTO_LIMIT + 1}`,
  );
  const list = rows.slice(0, REPORT_PHOTO_LIMIT).map((row): PhotoProblemDto => {
    const issues: PhotoProblemDto['issues'] = [];
    if (row.alt_missing_uk) issues.push('alt_missing_uk');
    if (row.alt_missing_en) issues.push('alt_missing_en');
    if (row.alt_too_short) issues.push('alt_too_short');
    if (row.alt_too_long) issues.push('alt_too_long');
    if (row.too_narrow) issues.push('too_narrow');
    if (row.aspect) issues.push('aspect');
    if (row.renditions_missing) issues.push('renditions_missing');
    if (row.url_unsafe) issues.push('url_unsafe');
    return {
      imageId: row.id,
      productId: row.product_id,
      productSku: row.sku,
      width: row.width,
      height: row.height,
      issues,
    };
  });
  return {
    total: totals?.total ?? 0,
    problems: totals?.problems ?? 0,
    list,
    truncated: rows.length > REPORT_PHOTO_LIMIT,
  };
}
