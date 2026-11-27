/**
 * The product view counter (phase 10), the data behind "viewed but not bought".
 *
 * What is stored: one row per (product, anonymous session hash, UTC day): no IP, no user agent, no
 * cookie, no customer id. The hash is HMAC-SHA256 under a server secret of the UTC day, the client
 * address and the user agent, so it cannot be reversed without the secret, differs every day (a
 * visitor cannot be followed across days), and a repeat view on the same day is the same row (the
 * unique index), so reloading a page counts once. Only a product the storefront shows
 * (`visibleProduct`) can get a row, and the answer never says whether it did.
 *
 * It is a rough count of sessions per day, not an audit: anyone who changes address and agent can
 * add rows, which is why the route limits per client and in total (docs/REPORTS.md, Q88).
 * Rows older than 90 days are removed by the `views.cleanup` job.
 */
import { createHmac } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Tx } from '@store/db/types';

import { visibleProduct } from '../catalog/sql.ts';

export const PRODUCT_VIEW_KEEP_DAYS = 90;

/** The hash that stands for "one visitor on one day". Pure. */
export function viewSessionHash(
  secret: string,
  input: { day: string; client: string; userAgent: string },
): string {
  return createHmac('sha256', secret)
    .update(`product-view|${input.day}|${input.client}|${input.userAgent.slice(0, 200)}`)
    .digest('hex');
}

/** `true` when a new row was written (a repeat, an unknown or a hidden product writes nothing). */
export async function recordProductView(
  tx: Tx,
  input: { productId: string; sessionHash: string },
): Promise<boolean> {
  const result = await tx.execute(sql`
    INSERT INTO product_views (product_id, session_hash, viewed_on)
    SELECT p.id, ${input.sessionHash}, (now() AT TIME ZONE 'UTC')::date
      FROM products p
     WHERE p.id = ${input.productId}::uuid AND ${visibleProduct}
    ON CONFLICT (product_id, session_hash, viewed_on) DO NOTHING
    RETURNING id`);
  return result.rows.length > 0;
}

/** Removes views older than the retention (the database's UTC date decides). Returns how many. */
export async function purgeProductViews(
  tx: Tx,
  options: { keepDays?: number } = {},
): Promise<number> {
  const keep = Math.trunc(options.keepDays ?? PRODUCT_VIEW_KEEP_DAYS);
  const result = await tx.execute(sql`
    DELETE FROM product_views
     WHERE viewed_on < (now() AT TIME ZONE 'UTC')::date - ${keep}::int
    RETURNING id`);
  return result.rows.length;
}
