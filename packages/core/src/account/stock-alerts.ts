/**
 * "Tell me when this size is back". A subscription belongs to a SIGNED-IN, verified address (the
 * account's own): nobody can subscribe someone else's mailbox, so the shop cannot be used to mail
 * strangers. One alert per (variant, address); resubscribing after it was sent re-arms it. The worker
 * claims each waiting alert exactly once (`notifyRestocked`) and queues one mail with the alert id
 * as the only payload; the unsubscribe link is `<id>.<HMAC(id)>` under a derived key, so it works
 * without a session and cannot be guessed.
 */
import { and, eq, sql } from 'drizzle-orm';

import { outbox, stockNotifications } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { stockAlertDto, type StockAlertDto } from '@store/shared/dto/account';
import { serialize } from '@store/shared/dto/serialize';

import { writeAudit } from '../audit/write-audit.ts';
import { buildUnsubscribeToken, readUnsubscribeToken } from './unsubscribe-token.ts';
import { DomainError } from '../errors.ts';

export const MAX_ALERTS = 50;
export { buildUnsubscribeToken, readUnsubscribeToken };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AlertVariantNotFoundError extends DomainError {
  constructor() {
    super('ALERT_NOT_FOUND', 'Variant not found');
  }
}
export class AlertNotNeededError extends DomainError {
  constructor() {
    super('ALERT_AVAILABLE', 'This size can be bought now');
  }
}
export class AlertLimitError extends DomainError {
  constructor() {
    super('ALERT_LIMIT', 'Too many alerts');
  }
}

interface Who {
  customerId: string;
  userId: string;
  email: string;
  locale: 'uk' | 'en';
  ip: string | null;
}

/** Subscribes the account's address to a variant that cannot be bought now. Returns the alert id. */
export async function subscribeStockAlert(
  tx: Tx,
  who: Who,
  variantId: string,
  maxAlerts = MAX_ALERTS,
): Promise<string> {
  if (!UUID.test(variantId)) throw new AlertVariantNotFoundError();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`alerts:${who.customerId}`}, 0))`,
  );
  const found = await tx.execute<{ available: boolean }>(
    sql`SELECT (v.is_active AND v.stock_quantity - v.reserved_quantity > 0) AS available
          FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE v.id = ${variantId}::uuid AND v.is_active AND p.is_active
           AND p.kind = 'physical' AND p.published_at IS NOT NULL AND p.published_at <= now()`,
  );
  const variant = found.rows[0];
  if (variant === undefined) throw new AlertVariantNotFoundError();
  if (variant.available) throw new AlertNotNeededError();
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(stockNotifications)
    .where(
      and(eq(stockNotifications.email, who.email), sql`${stockNotifications.notifiedAt} IS NULL`),
    );
  const [existing] = await tx
    .select({ id: stockNotifications.id })
    .from(stockNotifications)
    .where(
      and(eq(stockNotifications.variantId, variantId), eq(stockNotifications.email, who.email)),
    );
  if (existing === undefined && (count?.n ?? 0) >= maxAlerts) throw new AlertLimitError();
  const [row] = await tx
    .insert(stockNotifications)
    .values({ variantId, email: who.email, locale: who.locale })
    .onConflictDoUpdate({
      target: [stockNotifications.variantId, stockNotifications.email],
      set: { notifiedAt: null, locale: who.locale },
    })
    .returning({ id: stockNotifications.id });
  if (row === undefined) throw new Error('alert insert returned no row');
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.stock_alert_added',
    entity: 'stock_notification',
    entityId: row.id,
    ip: who.ip,
  });
  return row.id;
}

/** Removes MY alert; another customer's id is "not found" (false). */
export async function cancelStockAlert(tx: Tx, who: Who, alertId: string): Promise<boolean> {
  if (!UUID.test(alertId)) return false;
  const removed = await tx
    .delete(stockNotifications)
    .where(and(eq(stockNotifications.id, alertId), eq(stockNotifications.email, who.email)))
    .returning({ id: stockNotifications.id });
  if (removed.length > 0) {
    await writeAudit(tx, {
      userId: who.userId,
      action: 'customer.stock_alert_removed',
      entity: 'stock_notification',
      entityId: alertId,
      ip: who.ip,
    });
  }
  return removed.length > 0;
}

/** The unsubscribe link of a mail: no session, the signed id is the credential. Idempotent. */
export async function unsubscribeByToken(
  tx: Tx,
  secret: string | undefined,
  token: string,
): Promise<boolean> {
  const id = readUnsubscribeToken(secret, token);
  if (id === null) return false;
  const removed = await tx
    .delete(stockNotifications)
    .where(eq(stockNotifications.id, id))
    .returning({ id: stockNotifications.id });
  if (removed.length > 0) {
    await writeAudit(tx, {
      userId: null,
      action: 'customer.stock_alert_unsubscribed_by_link',
      entity: 'stock_notification',
      entityId: id,
    });
  }
  return true;
}

export async function listMyStockAlerts(
  reader: Reader,
  email: string,
  locale: 'uk' | 'en',
): Promise<StockAlertDto[]> {
  const result = await reader.execute<{
    id: string;
    slug: string;
    name: string;
    size: string;
    color: string;
    waiting: boolean;
  }>(
    sql`SELECT n.id, p.slug, ${locale === 'en' ? sql`p.name_en` : sql`p.name_uk`} AS name,
               s.label AS size, ${locale === 'en' ? sql`c.name_en` : sql`c.name_uk`} AS color,
               n.notified_at IS NULL AS waiting
          FROM stock_notifications n
          JOIN product_variants v ON v.id = n.variant_id
          JOIN products p ON p.id = v.product_id
          JOIN sizes s ON s.id = v.size_id
          JOIN colors c ON c.id = v.color_id
         WHERE n.email = ${email}
         ORDER BY n.created_at DESC, n.id`,
  );
  return result.rows.map((row) =>
    serialize(stockAlertDto, {
      id: row.id,
      productSlug: row.slug,
      productName: row.name,
      sizeLabel: row.size,
      colorName: row.color,
      waiting: row.waiting,
    }),
  );
}

/**
 * Worker side: claims every waiting alert whose variant can be bought now and queues ONE mail per
 * alert, in one transaction. The claim is a conditional UPDATE (`notified_at IS NULL`), so two
 * workers, a retry or a second run cannot send an alert twice: a parallel run waits for the row lock
 * and re-checks `notified_at IS NULL`, so it skips what the first run took. A re-armed alert gets a
 * new queue key and can send again later. The payload is the alert id and nothing else.
 */
export async function notifyRestocked(tx: Tx, limit = 200): Promise<number> {
  const claimed = await tx.execute<{ id: string }>(
    sql`UPDATE stock_notifications n SET notified_at = now()
         WHERE n.notified_at IS NULL AND n.id IN (
           SELECT n2.id FROM stock_notifications n2
             JOIN product_variants v ON v.id = n2.variant_id
             JOIN products p ON p.id = v.product_id
            WHERE n2.notified_at IS NULL AND v.is_active AND v.stock_quantity - v.reserved_quantity > 0
              AND p.is_active AND p.kind = 'physical' AND p.published_at IS NOT NULL AND p.published_at <= now()
            ORDER BY n2.created_at, n2.id
            LIMIT ${limit})
         RETURNING n.id`,
  );
  for (const row of claimed.rows) {
    await tx
      .insert(outbox)
      .values({
        topic: 'email.back-in-stock',
        payload: { alertId: row.id },
        dedupKey: `back-in-stock:${row.id}:${Date.now().toString(36)}`,
      })
      .onConflictDoNothing();
  }
  return claimed.rows.length;
}

/**
 * At send time: if the size sold out again after the alert was claimed, the alert goes back to waiting
 * (one statement, so nothing is lost and nothing is mailed "back in stock" for a size that is gone).
 * Returns true when it was re-armed. The worker passes its database handle; this is a single UPDATE.
 */
export async function rearmIfSoldOut(db: Reader, alertId: string): Promise<boolean> {
  const result = await db.execute(
    sql`UPDATE stock_notifications n SET notified_at = NULL
          FROM product_variants v
         WHERE n.id = ${alertId}::uuid AND v.id = n.variant_id AND n.notified_at IS NOT NULL
           AND NOT (v.is_active AND v.stock_quantity - v.reserved_quantity > 0)`,
  );
  return (result.rowCount ?? 0) > 0;
}
