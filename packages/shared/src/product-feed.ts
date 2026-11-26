/**
 * Product feeds (phase 6): Google Merchant Center RSS 2.0 and a Meta catalog CSV. One `FeedItem`
 * per VARIANT, grouped by product through `item_group_id`. Pure strings. Every text value is
 * cleaned of control characters and escaped for its format; prices are integer kopiykas converted
 * once, by `toHryvniasText`, and no field the shop keeps private (cost, stock counts) exists in
 * `FeedItem`, so it cannot be written.
 */
import { toHryvniasText, type Money } from './money';
import { escapeXml } from './sitemap-xml';

export interface FeedItem {
  /** Variant SKU: stable and unique per size and colour. */
  id: string;
  /** The product (its id, not its slug: a renamed slug must not split a group). */
  groupId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string | null;
  additionalImages: readonly string[];
  inStock: boolean;
  /** The regular price; with `salePrice` set it is the crossed-out one. */
  price: Money;
  salePrice: Money | null;
  brand: string;
  /** Only a valid GTIN (8, 12, 13 or 14 digits); anything else is dropped. */
  gtin: string | null;
  mpn: string;
  size: string;
  color: string;
  productType: string;
}

export const FEED_CURRENCY = 'UAH';
/** The shop sells women's underwear and homewear; the schema has no per-product gender. */
export const FEED_GENDER = 'female';
export const FEED_AGE_GROUP = 'adult';
export const GOOGLE_CATEGORY = 'Apparel & Accessories > Clothing > Underwear & Socks';

export const TITLE_MAX = 150;
export const DESCRIPTION_MAX = 5000;
export const MAX_ADDITIONAL_IMAGES = 10;

/** C0 controls that XML 1.0 forbids (tab, line feed and carriage return stay). */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Text for a feed field: no control characters, one line of single spaces, cut on a code point. */
export function feedText(value: string, max: number): string {
  const flat = value.replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  return points.length <= max
    ? flat
    : `${points
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

export function validGtin(barcode: string | null): string | null {
  return barcode !== null && /^(?:\d{8}|\d{12,14})$/.test(barcode) ? barcode : null;
}

const price = (amount: Money): string => `${toHryvniasText(amount)} ${FEED_CURRENCY}`;
const tag = (name: string, value: string): string => `<g:${name}>${escapeXml(value)}</g:${name}>`;

export function googleFeedOpen(input: {
  title: string;
  link: string;
  description: string;
}): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n' +
    `<title>${escapeXml(input.title)}</title>\n<link>${escapeXml(input.link)}</link>\n` +
    `<description>${escapeXml(input.description)}</description>\n`
  );
}
export const GOOGLE_FEED_CLOSE = '</channel>\n</rss>\n';

export function googleItemXml(item: FeedItem): string {
  const parts = [
    tag('id', item.id),
    `<title>${escapeXml(feedText(item.title, TITLE_MAX))}</title>`,
    `<description>${escapeXml(feedText(item.description === '' ? item.title : item.description, DESCRIPTION_MAX))}</description>`,
    `<link>${escapeXml(item.link)}</link>`,
    ...(item.imageLink === null ? [] : [tag('image_link', item.imageLink)]),
    ...item.additionalImages
      .slice(0, MAX_ADDITIONAL_IMAGES)
      .map((url) => tag('additional_image_link', url)),
    tag('availability', item.inStock ? 'in_stock' : 'out_of_stock'),
    // With a sale, `price` is the regular price and `sale_price` the current one.
    tag('price', price(item.price)),
    ...(item.salePrice === null ? [] : [tag('sale_price', price(item.salePrice))]),
    tag('condition', 'new'),
    tag('brand', feedText(item.brand, 70)),
    ...(item.gtin === null ? [] : [tag('gtin', item.gtin)]),
    tag('mpn', feedText(item.mpn, 70)),
    ...(item.gtin === null ? [tag('identifier_exists', 'no')] : []),
    tag('item_group_id', item.groupId),
    tag('google_product_category', GOOGLE_CATEGORY),
    tag('product_type', feedText(item.productType, 750)),
    tag('size', feedText(item.size, 100)),
    tag('color', feedText(item.color, 100)),
    tag('gender', FEED_GENDER),
    tag('age_group', FEED_AGE_GROUP),
  ];
  return `<item>\n${parts.join('\n')}\n</item>\n`;
}

export const FACEBOOK_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'sale_price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
  'gtin',
  'mpn',
  'item_group_id',
  'google_product_category',
  'product_type',
  'size',
  'color',
  'gender',
  'age_group',
] as const;

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const facebookCsvHeader = (): string => `${FACEBOOK_COLUMNS.join(',')}\r\n`;

/** One CSV line. No BOM and no formula guard: a catalog importer reads text, a spreadsheet never opens it. */
export function facebookCsvRow(item: FeedItem): string {
  const cells: Record<(typeof FACEBOOK_COLUMNS)[number], string> = {
    id: item.id,
    title: feedText(item.title, TITLE_MAX),
    description: feedText(item.description === '' ? item.title : item.description, DESCRIPTION_MAX),
    availability: item.inStock ? 'in stock' : 'out of stock',
    condition: 'new',
    price: price(item.price),
    sale_price: item.salePrice === null ? '' : price(item.salePrice),
    link: item.link,
    image_link: item.imageLink ?? '',
    additional_image_link: item.additionalImages.slice(0, MAX_ADDITIONAL_IMAGES).join(','),
    brand: feedText(item.brand, 70),
    gtin: item.gtin ?? '',
    mpn: feedText(item.mpn, 70),
    item_group_id: item.groupId,
    google_product_category: GOOGLE_CATEGORY,
    product_type: feedText(item.productType, 750),
    size: feedText(item.size, 100),
    color: feedText(item.color, 100),
    gender: FEED_GENDER,
    age_group: FEED_AGE_GROUP,
  };
  return `${FACEBOOK_COLUMNS.map((column) => csvCell(cells[column])).join(',')}\r\n`;
}
