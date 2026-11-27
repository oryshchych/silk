/**
 * The product view counter (phase 10), the data behind "viewed but not bought".
 *
 * What is stored: one row per (product, anonymous session hash, UTC day): no IP, no user agent, no
 * cookie, no customer id. The hash is HMAC-SHA256, under a key derived from the server secret, of the
 * UTC day and the client address, so it cannot be reversed without the secret, differs every day (a
 * visitor cannot be followed across days), and a repeat view on the same day is the same row (the
 * unique index), so reloading a page counts once. Only a product the storefront shows
 * (`visibleProduct`) can get a row, and the answer never says whether it did.
 *
 * It is a rough count of sessions per day, not an audit: anyone who changes address and agent can
 * add rows, which is why the route limits per client and in total (docs/REPORTS.md, Q88).
 * Rows older than 90 days are removed by the `views.cleanup` job.
 */
import { createHmac, hkdfSync } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Tx } from '@store/db/types';

import { visibleProduct } from '../catalog/sql.ts';

export const PRODUCT_VIEW_KEEP_DAYS = 90;

/**
 * The hash that stands for "one visitor on one day": the client address and the UTC day, under a key
 * derived for this purpose from the server secret (HKDF, `product-view`), so the secret is never used
 * directly and the same secret cannot forge anything else. The user agent is NOT part of it: the
 * client controls it, and a rotating agent would turn one visitor into many rows. Pure.
 */
export function viewSessionHash(secret: string, input: { day: string; client: string }): string {
  const key = Buffer.from(hkdfSync('sha256', secret, '', 'product-view', 32));
  return createHmac('sha256', key).update(`${input.day}|${input.client}`).digest('hex');
}

/** The write is small: a hung database must not hold the storefront's connection (500 ms). */
const WRITE_TIMEOUT_MS = 500;

/** `true` when a new row was written (a repeat, an unknown or a hidden product writes nothing). */
export async function recordProductView(
  tx: Tx,
  input: { productId: string; sessionHash: string },
): Promise<boolean> {
  await tx.execute(sql`SELECT set_config('statement_timeout', ${String(WRITE_TIMEOUT_MS)}, true)`);
  const result = await tx.execute(sql`
    INSERT INTO product_views (product_id, session_hash, viewed_on)
    SELECT p.id, ${input.sessionHash}, (now() AT TIME ZONE 'UTC')::date
      FROM products p
     WHERE p.id = ${input.productId}::uuid AND ${visibleProduct}
    ON CONFLICT (product_id, session_hash, viewed_on) DO NOTHING
    RETURNING id`);
  return result.rows.length > 0;
}

export interface BatchDb {
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export const PURGE_BATCH = 5_000;
/** At most this many batches per run (1 000 000 rows at the default batch); the next run continues. */
export const PURGE_MAX_ROUNDS = 200;

/**
 * Removes views older than the retention (the database's UTC date decides), in batches of
 * `batchSize`, each its own short transaction, so a large backlog never holds a long lock or one huge
 * statement. Returns how many were removed.
 */
export async function purgeProductViews(
  db: BatchDb,
  options: { keepDays?: number; batchSize?: number; maxRounds?: number } = {},
): Promise<number> {
  const keep = Math.trunc(options.keepDays ?? PRODUCT_VIEW_KEEP_DAYS);
  const batch = Math.trunc(options.batchSize ?? PURGE_BATCH);
  const rounds = Math.trunc(options.maxRounds ?? PURGE_MAX_ROUNDS);
  let removed = 0;
  for (let round = 0; round < rounds; round += 1) {
    const count = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        DELETE FROM product_views
         WHERE id IN (
           SELECT id FROM product_views
            WHERE viewed_on < (now() AT TIME ZONE 'UTC')::date - ${keep}::int
            ORDER BY viewed_on LIMIT ${batch})`);
      return result.rowCount ?? 0;
    });
    removed += count;
    if (count < batch) break;
  }
  return removed;
}
