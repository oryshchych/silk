/**
 * The columns of the content CSV: one list for the import, the template download, the preview's
 * missing-content notes and the guide (`docs/CONTENT_GUIDE.md`; a test fails when the guide forgets
 * a column). `dbMax` is what the database and the editor accept; `bound` names the editorial bound
 * of `CONTENT_BOUNDS` that the preview reports against.
 */
import type { ContentField } from './content-bounds';

export const CONTENT_LOCALES = ['uk', 'en'] as const;

export interface ContentColumn {
  column: string;
  /** The key of `productContentSchema` this column writes. */
  key: string;
  bound: ContentField;
  dbMax: number;
  label: { uk: string; en: string };
}

const spec = (
  name: string,
  key: string,
  bound: ContentField,
  dbMax: number,
  uk: string,
  en: string,
): readonly [ContentColumn, ContentColumn] =>
  [
    {
      column: `${name}_uk`,
      key: `${key}Uk`,
      bound,
      dbMax,
      label: { uk: `${uk} (українською)`, en: `${en} (Ukrainian)` },
    },
    {
      column: `${name}_en`,
      key: `${key}En`,
      bound,
      dbMax,
      label: { uk: `${uk} (англійською)`, en: `${en} (English)` },
    },
  ] as const;

/** The text columns the import writes beyond the basics (names are basics: `name_uk`, `name_en`). */
export const CONTENT_COLUMNS: readonly ContentColumn[] = [
  ...spec(
    'short_description',
    'shortDescription',
    'shortDescription',
    500,
    'Короткий опис',
    'Short description',
  ),
  ...spec('description', 'description', 'description', 20_000, 'Повний опис', 'Full description'),
  ...spec('composition', 'composition', 'composition', 5_000, 'Склад', 'Composition'),
  ...spec('care', 'care', 'care', 5_000, 'Догляд', 'Care'),
  ...spec('meta_title', 'metaTitle', 'metaTitle', 200, 'Meta title', 'Meta title'),
  ...spec(
    'meta_description',
    'metaDescription',
    'metaDescription',
    400,
    'Meta description',
    'Meta description',
  ),
];

/** Names are measured against the editorial bound too, and are required to create a product. */
export const NAME_COLUMNS = ['name_uk', 'name_en'] as const;

/** The basics the importer already knows (see `import.ts`). */
export const BASIC_COLUMNS = [
  'sku',
  'slug',
  'brand',
  'category',
  'name_uk',
  'name_en',
  'price',
  'compare_at_price',
  'cost_price',
  'weight_grams',
] as const;

/** The header of the template: the basics (without the cost: a content editor may not write it), then the content columns. */
export const TEMPLATE_BASIC_COLUMNS = BASIC_COLUMNS.filter((column) => column !== 'cost_price');

/** A SKU starting with this is the template's example row: refused, never loaded. */
export const EXAMPLE_SKU_PREFIX = 'EXAMPLE-';
