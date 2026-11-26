/**
 * A customer's review. Who may write one is decided HERE, from the database, never from the request:
 * the customer must hold an order of their own (`orders.customer_id` = the session's customer) with a
 * line of THAT product, not cancelled or returned, and shipped, delivered or paid. The size on the
 * review is copied from that order line (a claim of the reviewer is not accepted). One review per
 * (product, customer) (a unique index and a lock), five a day per customer, text bounded and stripped
 * of control characters; a new review is PENDING and invisible until a moderator approves it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { reviews } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { fitValues } from '@store/shared/dto/review';

import { writeAudit } from '../audit/write-audit.ts';
import { DomainError } from '../errors.ts';

export const MAX_REVIEWS_PER_DAY = 5;

export class ReviewNotAllowedError extends DomainError {
  constructor() {
    super('REVIEW_NOT_ALLOWED', 'Only a buyer of this product can review it');
  }
}
export class ReviewExistsError extends DomainError {
  constructor() {
    super('REVIEW_EXISTS', 'This product was already reviewed');
  }
}
export class ReviewTooManyError extends DomainError {
  constructor() {
    super('REVIEW_RATE', 'Too many reviews today');
  }
}

const plain = (max: number) =>
  z
    .string()
    .max(max * 2)
    // Control characters except the line break are dropped; the text is stored as plain text and only
    // ever rendered escaped (React in the page, `escapeHtml` in a mail).
    .transform((value) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim())
    .pipe(z.string().max(max));

export const reviewInputSchema = z.object({
  productId: z.uuid(),
  rating: z.number().int().min(1).max(5),
  title: plain(120).transform((value) => (value === '' ? null : value)),
  body: plain(2000).transform((value) => (value === '' ? null : value)),
  fit: z.enum(fitValues).nullable(),
});
export type ReviewInput = z.output<typeof reviewInputSchema>;

/** The order line that makes this customer a buyer of this product, or null. */
export async function findPurchase(
  reader: Reader,
  customerId: string,
  productId: string,
): Promise<{ orderId: string; sizeLabel: string } | null> {
  const result = await reader.execute<{ order_id: string; size_label: string }>(
    sql`SELECT o.id AS order_id, i.size_label
          FROM orders o JOIN order_items i ON i.order_id = o.id
         WHERE o.customer_id = ${customerId}::uuid AND i.product_id = ${productId}::uuid
           AND o.status NOT IN ('cancelled', 'returned')
           AND (o.status IN ('shipped', 'delivered') OR o.payment_status = 'paid')
         ORDER BY o.created_at DESC, o.id LIMIT 1`,
  );
  const row = result.rows[0];
  return row === undefined ? null : { orderId: row.order_id, sizeLabel: row.size_label };
}

interface Who {
  customerId: string;
  userId: string;
  ip: string | null;
}

export async function submitReview(
  tx: Tx,
  who: Who,
  input: ReviewInput,
  maxPerDay = MAX_REVIEWS_PER_DAY,
): Promise<string> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review:${who.customerId}`}, 0))`,
  );
  const purchase = await findPurchase(tx, who.customerId, input.productId);
  if (purchase === null) throw new ReviewNotAllowedError();
  const [today] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(reviews)
    .where(
      and(
        eq(reviews.customerId, who.customerId),
        sql`${reviews.createdAt} > now() - interval '1 day'`,
      ),
    );
  if ((today?.n ?? 0) >= maxPerDay) throw new ReviewTooManyError();
  const [existing] = await tx
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.productId, input.productId), eq(reviews.customerId, who.customerId)));
  if (existing !== undefined) throw new ReviewExistsError();
  const [row] = await tx
    .insert(reviews)
    .values({
      productId: input.productId,
      customerId: who.customerId,
      orderId: purchase.orderId,
      rating: input.rating,
      title: input.title,
      body: input.body,
      sizeBought: purchase.sizeLabel,
      fitFeedback: input.fit,
      isApproved: false,
    })
    .returning({ id: reviews.id });
  if (row === undefined) throw new Error('review insert returned no row');
  // The text is not copied into the audit row.
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.review_submitted',
    entity: 'review',
    entityId: row.id,
    ip: who.ip,
  });
  return row.id;
}

export interface EligibleLine {
  productId: string;
  name: string;
  sizeLabel: string;
  reviewed: boolean;
}

/** The products of MY orders that can be reviewed, and whether I already did. */
export async function listReviewableProducts(
  reader: Reader,
  customerId: string,
  locale: 'uk' | 'en',
): Promise<EligibleLine[]> {
  const result = await reader.execute<{
    product_id: string;
    name: string;
    size_label: string;
    reviewed: boolean;
  }>(
    sql`SELECT DISTINCT ON (i.product_id) i.product_id, ${locale === 'en' ? sql`p.name_en` : sql`p.name_uk`} AS name,
               i.size_label,
               EXISTS (SELECT 1 FROM reviews r WHERE r.product_id = i.product_id AND r.customer_id = ${customerId}::uuid) AS reviewed
          FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
         WHERE o.customer_id = ${customerId}::uuid
           AND o.status NOT IN ('cancelled', 'returned')
           AND (o.status IN ('shipped', 'delivered') OR o.payment_status = 'paid')
         ORDER BY i.product_id, o.created_at DESC`,
  );
  return result.rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    sizeLabel: row.size_label,
    reviewed: row.reviewed,
  }));
}
