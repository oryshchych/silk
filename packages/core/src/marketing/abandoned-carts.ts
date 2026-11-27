/**
 * Abandoned-cart reminder (phase 11). ONE mail per cart, and at most one per customer per week, to a signed-in
 * customer who gave marketing consent (an active, confirmed `newsletter_subscribers` row AND the account's
 * flag): a guest cart has no address and is never mailed.
 *
 * `claimAbandonedCarts` runs as one transaction: a global advisory lock serialises claims (so the per-customer
 * cap cannot be raced), candidate carts are locked with SKIP LOCKED (a cart held by an open checkout is left
 * for the next run, it never stalls the batch), then ONE conditional UPDATE sets `abandoned_email_sent_at`
 * (never cleared) and the outbox rows are queued in the same transaction. The row carries the cart id, the
 * cart's last-activity instant and its `version` as seen at the claim: the touch trigger bumps `updated_at`
 * on the claim itself, so those two are the stable facts the send-time check compares against.
 *
 * `readCartReminder` re-checks at send time: converted, consent withdrawn, ordered since the cart's activity
 * (an order that committed after the claim included), the cart changed since the claim (`version`), too old
 * (the claim is older than the send window), or nothing in it can be bought now.
 */
import { sql } from 'drizzle-orm';

import { outbox } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';

import { acquireLocksSkipLocked } from '../locks/acquire-locks.ts';

/** Idle for this long before a cart counts as abandoned. */
export const ABANDONED_AFTER_HOURS = 2;
/** Older than this, a reminder would be noise. */
export const ABANDONED_MAX_AGE_HOURS = 72;
/** A customer gets at most one cart reminder in this many days, whatever number of carts they left. */
export const CUSTOMER_REMINDER_CAP_DAYS = 7;
/** A claimed reminder that has not been sent within this many hours (a stuck relay) is dropped. */
export const REMINDER_SEND_WINDOW_HOURS = 24;

const CLAIM_LOCK_KEY = 'carts:remind-claim';

/** An order by this customer (account or address) created at or after `since`. */
const ORDERED_SINCE = (customer: string, since: ReturnType<typeof sql>) => sql`(
  EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = ${sql.raw(customer)}.id AND o.created_at >= ${since})
  OR EXISTS (SELECT 1 FROM orders o WHERE lower(o.customer_email) = ${sql.raw(customer)}.email
               AND o.created_at >= ${since}))`;

export async function claimAbandonedCarts(tx: Tx, limit = 200): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0))`);
  const candidates = await tx.execute<{ id: string }>(
    sql`SELECT c.id FROM carts c
         WHERE c.abandoned_email_sent_at IS NULL AND c.customer_id IS NOT NULL
           AND c.updated_at < now() - make_interval(hours => ${ABANDONED_AFTER_HOURS})
           AND c.updated_at > now() - make_interval(hours => ${ABANDONED_MAX_AGE_HOURS})
         ORDER BY c.updated_at, c.id LIMIT ${limit * 4}`,
  );
  const locked = await acquireLocksSkipLocked(
    tx,
    'carts',
    candidates.rows.map((row) => row.id),
  );
  if (locked.length === 0) return 0;
  const idList = sql.join(
    locked.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // After the locks: this statement sees everything committed so far, so the checks below are current.
  const claimed = await tx.execute<{ id: string; active_at: Date; version: number }>(
    sql`WITH eligible AS (
          SELECT c.id, c.customer_id, c.updated_at AS active_at, c.version
            FROM carts c
            JOIN customers cu ON cu.id = c.customer_id
            JOIN newsletter_subscribers s ON s.email = cu.email
           WHERE c.id IN (${idList})
             AND c.abandoned_email_sent_at IS NULL AND c.converted_at IS NULL
             AND c.converted_order_id IS NULL
             AND cu.accepts_marketing AND s.confirmed_at IS NOT NULL AND s.unsubscribed_at IS NULL
             AND EXISTS (SELECT 1 FROM cart_items i WHERE i.cart_id = c.id)
             AND NOT ${ORDERED_SINCE('cu', sql`c.updated_at`)}
             AND NOT EXISTS (
               SELECT 1 FROM carts x WHERE x.customer_id = c.customer_id
                  AND x.abandoned_email_sent_at > now() - make_interval(days => ${CUSTOMER_REMINDER_CAP_DAYS}))),
        picked AS (
          SELECT DISTINCT ON (customer_id) id, active_at, version FROM eligible
           ORDER BY customer_id, active_at DESC, id
           LIMIT ${limit})
        UPDATE carts c SET abandoned_email_sent_at = now()
          FROM picked
         WHERE c.id = picked.id
        RETURNING c.id, picked.active_at, picked.version`,
  );
  for (const row of claimed.rows) {
    await tx
      .insert(outbox)
      .values({
        topic: 'email.cart-reminder',
        payload: {
          cartId: row.id,
          activeAt: new Date(row.active_at).toISOString(),
          version: row.version,
        },
        dedupKey: `cart-reminder:${row.id}`,
      })
      .onConflictDoNothing();
  }
  return claimed.rows.length;
}

export interface CartReminder {
  email: string;
  locale: 'uk' | 'en';
  subscriberId: string;
  items: { name: string; size: string; quantity: number; slug: string }[];
}

/** What the claim recorded about the cart: the instant of its last activity and its version. */
export interface ClaimedCart {
  cartId: string;
  activeAt: string;
  version: number;
}

/**
 * The facts at send time, or null when no reminder is due any more (see the file comment). The quantity shown
 * is capped at what is in stock.
 */
export async function readCartReminder(
  reader: Reader,
  claimed: ClaimedCart,
): Promise<CartReminder | null> {
  const head = await reader.execute<{ email: string; locale: string; subscriber_id: string }>(
    sql`SELECT cu.email, cu.locale, s.id AS subscriber_id
          FROM carts c
          JOIN customers cu ON cu.id = c.customer_id
          JOIN newsletter_subscribers s ON s.email = cu.email
         WHERE c.id = ${claimed.cartId}::uuid AND c.converted_at IS NULL AND c.converted_order_id IS NULL
           AND c.version = ${claimed.version}
           AND c.abandoned_email_sent_at IS NOT NULL
           AND c.abandoned_email_sent_at > now() - make_interval(hours => ${REMINDER_SEND_WINDOW_HOURS})
           AND cu.accepts_marketing AND s.confirmed_at IS NOT NULL AND s.unsubscribed_at IS NULL
           AND NOT ${ORDERED_SINCE('cu', sql`${claimed.activeAt}::timestamptz`)}`,
  );
  const who = head.rows[0];
  if (who === undefined) return null;
  const locale = who.locale === 'en' ? 'en' : 'uk';
  const lines = await reader.execute<{
    name_uk: string;
    name_en: string;
    size: string;
    quantity: number;
    slug: string;
  }>(
    sql`SELECT p.name_uk, p.name_en, sz.label AS size,
               LEAST(i.quantity, v.stock_quantity - v.reserved_quantity)::int AS quantity, p.slug
          FROM cart_items i
          JOIN product_variants v ON v.id = i.variant_id
          JOIN products p ON p.id = v.product_id
          JOIN sizes sz ON sz.id = v.size_id
         WHERE i.cart_id = ${claimed.cartId}::uuid AND v.is_active
           AND v.stock_quantity - v.reserved_quantity > 0
           AND p.is_active AND p.kind = 'physical' AND p.published_at IS NOT NULL AND p.published_at <= now()
         ORDER BY i.created_at, i.id LIMIT 10`,
  );
  if (lines.rows.length === 0) return null;
  return {
    email: who.email,
    locale,
    subscriberId: who.subscriber_id,
    items: lines.rows.map((row) => ({
      name: locale === 'en' ? row.name_en : row.name_uk,
      size: row.size,
      quantity: row.quantity,
      slug: row.slug,
    })),
  };
}
