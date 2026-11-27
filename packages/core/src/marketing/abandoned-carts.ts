/**
 * Abandoned-cart reminder (phase 11). ONE mail per cart, ever, to a signed-in customer who gave marketing
 * consent (an active, confirmed `newsletter_subscribers` row AND the account's flag): a guest cart has no
 * address and is never mailed.
 *
 * `claimAbandonedCarts` marks the carts in one conditional UPDATE (`abandoned_email_sent_at` is set once and
 * never cleared) and queues one outbox row per claimed cart, in the same transaction, with the cart id as the
 * only payload and a dedup key of the cart. Two workers claiming at once cannot take the same cart: the
 * second UPDATE re-checks the flag after the first commits. At send time `readCartReminder` re-checks the
 * facts (order placed, cart converted, consent withdrawn, goods gone): a stale claim sends nothing.
 */
import { sql } from 'drizzle-orm';

import { outbox } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';

/** Idle for this long before a cart counts as abandoned. */
export const ABANDONED_AFTER_HOURS = 2;
/** Older than this, a reminder would be noise. */
export const ABANDONED_MAX_AGE_HOURS = 72;

/** Customers who have placed an order since the cart last changed (by account or by address) are skipped. */
const ORDERED_SINCE = (cart: string, customer: string) => sql`(
  EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = ${sql.raw(customer)}.id
            AND o.created_at >= ${sql.raw(cart)}.updated_at)
  OR EXISTS (SELECT 1 FROM orders o WHERE lower(o.customer_email) = ${sql.raw(customer)}.email
            AND o.created_at >= ${sql.raw(cart)}.updated_at))`;

export async function claimAbandonedCarts(tx: Tx, limit = 200): Promise<number> {
  const claimed = await tx.execute<{ id: string }>(
    sql`UPDATE carts c SET abandoned_email_sent_at = now()
         WHERE c.abandoned_email_sent_at IS NULL AND c.converted_at IS NULL AND c.id IN (
           SELECT c2.id FROM carts c2
             JOIN customers cu ON cu.id = c2.customer_id
             JOIN newsletter_subscribers s ON s.email = cu.email
            WHERE c2.abandoned_email_sent_at IS NULL AND c2.converted_at IS NULL
              AND c2.converted_order_id IS NULL
              AND cu.accepts_marketing AND s.confirmed_at IS NOT NULL AND s.unsubscribed_at IS NULL
              AND c2.updated_at < now() - make_interval(hours => ${ABANDONED_AFTER_HOURS})
              AND c2.updated_at > now() - make_interval(hours => ${ABANDONED_MAX_AGE_HOURS})
              AND EXISTS (SELECT 1 FROM cart_items i WHERE i.cart_id = c2.id)
              AND NOT ${ORDERED_SINCE('c2', 'cu')}
            ORDER BY c2.updated_at, c2.id
            LIMIT ${limit})
        RETURNING c.id`,
  );
  for (const row of claimed.rows) {
    await tx
      .insert(outbox)
      .values({
        topic: 'email.cart-reminder',
        payload: { cartId: row.id },
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

/**
 * The facts at send time, or null when no reminder is due any more: the cart was converted, the customer
 * ordered since, consent was withdrawn, or nothing in it can be bought now.
 */
export async function readCartReminder(
  reader: Reader,
  cartId: string,
): Promise<CartReminder | null> {
  const head = await reader.execute<{
    email: string;
    locale: string;
    subscriber_id: string;
  }>(
    sql`SELECT cu.email, cu.locale, s.id AS subscriber_id
          FROM carts c
          JOIN customers cu ON cu.id = c.customer_id
          JOIN newsletter_subscribers s ON s.email = cu.email
         WHERE c.id = ${cartId}::uuid AND c.converted_at IS NULL AND c.converted_order_id IS NULL
           AND cu.accepts_marketing AND s.confirmed_at IS NOT NULL AND s.unsubscribed_at IS NULL
           AND NOT ${ORDERED_SINCE('c', 'cu')}`,
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
    sql`SELECT p.name_uk, p.name_en, sz.label AS size, i.quantity, p.slug
          FROM cart_items i
          JOIN product_variants v ON v.id = i.variant_id
          JOIN products p ON p.id = v.product_id
          JOIN sizes sz ON sz.id = v.size_id
         WHERE i.cart_id = ${cartId}::uuid AND v.is_active
           AND v.stock_quantity - v.reserved_quantity > 0
           AND p.is_active AND p.kind = 'physical' AND p.published_at IS NOT NULL AND p.published_at <= now()
         ORDER BY i.created_at, i.id LIMIT 10`,
  );
  if (lines.rows.length === 0) return null;
  const items = lines.rows.map((row) => ({
    name: locale === 'en' ? row.name_en : row.name_uk,
    size: row.size,
    quantity: row.quantity,
    slug: row.slug,
  }));
  return {
    email: who.email,
    locale,
    subscriberId: who.subscriber_id,
    items,
  };
}
