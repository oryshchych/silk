/**
 * The content template: the header the import understands, and ONE example row that the import
 * refuses by its SKU (`EXAMPLE-...`), so a file uploaded unchanged loads nothing. The example holds
 * placeholders that say what to write and how long it may be, never real product text.
 */
import { CONTENT_BOUNDS } from '@store/shared/content-bounds';
import {
  CONTENT_COLUMNS,
  EXAMPLE_SKU_PREFIX,
  TEMPLATE_BASIC_COLUMNS,
} from '@store/shared/content-columns';

import { writeCsv } from './csv.ts';

export const TEMPLATE_HEADER: readonly string[] = [
  ...TEMPLATE_BASIC_COLUMNS,
  ...CONTENT_COLUMNS.map((c) => c.column),
];

const BASIC_EXAMPLE: Record<string, string> = {
  sku: `${EXAMPLE_SKU_PREFIX}DO-NOT-IMPORT`,
  slug: 'example-latin-words-with-hyphens',
  brand: '[EXAMPLE] Brand as on the label',
  category: 'slug-of-an-existing-category',
  name_uk: '[ПРИКЛАД] Назва українською',
  name_en: '[EXAMPLE] Name in English',
  price: '0.00',
  compare_at_price: '',
  weight_grams: '200',
};

function exampleText(column: (typeof CONTENT_COLUMNS)[number]): string {
  const bound = CONTENT_BOUNDS[column.bound];
  const language = column.column.endsWith('_uk') ? 'Ukrainian' : 'English';
  return `[EXAMPLE] ${language}, ${String(bound.min)}-${String(bound.max)} characters`;
}

/** The CSV of the template (BOM, CRLF, formula-safe like every file this shop writes). */
export function contentTemplateCsv(): string {
  const example = TEMPLATE_HEADER.map((column) => {
    const basic = BASIC_EXAMPLE[column];
    if (basic !== undefined) return basic;
    const content = CONTENT_COLUMNS.find((c) => c.column === column);
    return content === undefined ? '' : exampleText(content);
  });
  return writeCsv(TEMPLATE_HEADER, [example]);
}
