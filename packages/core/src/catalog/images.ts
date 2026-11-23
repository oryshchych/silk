import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import type { ImageDto } from '@store/shared/dto/catalog';

import { safeMediaUrl } from './media-url.ts';
import { localized, queryRows, type SiteLocale } from './sql.ts';

const imageRow = z.object({
  product_id: z.uuid(),
  url: z.string(),
  alt: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

/**
 * Main image (first by sort order) for a batch of products in ONE query.
 * Missing alt text falls back to the product name, so an image is never
 * published without alt.
 */
export async function fetchMainImages(
  reader: Reader,
  products: readonly { id: string; name: string }[],
  locale: SiteLocale,
): Promise<Map<string, ImageDto>> {
  const images = new Map<string, ImageDto>();
  if (products.length === 0) return images;
  const ids = sql.join(
    products.map((product) => sql`${product.id}`),
    sql`, `,
  );
  const rows = await queryRows(
    reader,
    imageRow,
    sql`SELECT DISTINCT ON (i.product_id) i.product_id, i.url, ${localized('i', 'alt', locale)} AS alt,
               i.width, i.height
          FROM product_images i
         WHERE i.product_id IN (${ids})
         ORDER BY i.product_id, i.sort_order, i.id`,
  );
  const names = new Map(products.map((product) => [product.id, product.name]));
  for (const row of rows) {
    const url = safeMediaUrl(row.url);
    if (url === null) continue;
    images.set(row.product_id, {
      url,
      alt: row.alt ?? names.get(row.product_id) ?? '',
      width: row.width,
      height: row.height,
    });
  }
  return images;
}
