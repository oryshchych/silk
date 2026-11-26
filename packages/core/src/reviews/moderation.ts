/**
 * Moderation (admin, `reviews.moderate`). Approve, refuse and reply; every change recomputes the product's
 * counters (`rating_avg`, `reviews_count`, `fit_true_count`, `fit_total_count`) from the APPROVED rows in the
 * same transaction, so the numbers the page and the JSON-LD show can never drift from the visible
 * reviews. A refused review stays (the buyer cannot resubmit it) but is never shown.
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { reviews } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { adminReviewDto, type AdminReviewDto } from '@store/shared/dto/review';
import { serialize } from '@store/shared/dto/serialize';

import { AdminNotFoundError } from '../catalog-admin/errors.ts';

export const reviewDecisionSchema = z.object({
  id: z.uuid(),
  decision: z.enum(['approve', 'reject']),
});
export const reviewReplySchema = z.object({
  id: z.uuid(),
  reply: z
    .string()
    .max(4000)
    .transform((value) =>
      value
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
        .trim(),
    )
    .pipe(z.string().max(2000))
    .transform((value) => (value === '' ? null : value)),
});

/** Recomputes the counters of one product from its approved reviews. */
export async function recomputeProductAggregates(tx: Tx, productId: string): Promise<void> {
  await tx.execute(
    sql`UPDATE products p
           SET rating_avg = s.avg, reviews_count = s.cnt, fit_true_count = s.fit_true, fit_total_count = s.fit_total
          FROM (SELECT (SELECT avg(rating)::real FROM reviews WHERE product_id = ${productId}::uuid AND is_approved) AS avg,
                       (SELECT count(*)::int FROM reviews WHERE product_id = ${productId}::uuid AND is_approved) AS cnt,
                       (SELECT count(*)::int FROM reviews WHERE product_id = ${productId}::uuid AND is_approved AND fit_feedback = 'true_to_size') AS fit_true,
                       (SELECT count(fit_feedback)::int FROM reviews WHERE product_id = ${productId}::uuid AND is_approved) AS fit_total) s
         WHERE p.id = ${productId}::uuid`,
  );
}

export async function listReviewsForModeration(
  reader: Reader,
  filter: 'pending' | 'approved' | 'rejected',
  limit = 100,
): Promise<AdminReviewDto[]> {
  const condition =
    filter === 'pending'
      ? sql`NOT r.is_approved AND r.rejected_at IS NULL`
      : filter === 'approved'
        ? sql`r.is_approved`
        : sql`r.rejected_at IS NOT NULL`;
  const result = await reader.execute<{
    id: string;
    product_id: string;
    name: string;
    slug: string;
    rating: number;
    title: string | null;
    body: string | null;
    size_bought: string | null;
    fit_feedback: string | null;
    approved: boolean;
    rejected: boolean;
    admin_reply: string | null;
    created_at: Date;
  }>(
    sql`SELECT r.id, r.product_id, p.name_uk AS name, p.slug, r.rating, r.title, r.body, r.size_bought,
               r.fit_feedback, r.is_approved AS approved, r.rejected_at IS NOT NULL AS rejected, r.admin_reply, r.created_at
          FROM reviews r JOIN products p ON p.id = r.product_id
         WHERE ${condition} ORDER BY r.created_at, r.id LIMIT ${limit}`,
  );
  return result.rows.map((row) =>
    serialize(adminReviewDto, {
      id: row.id,
      productId: row.product_id,
      productName: row.name,
      productSlug: row.slug,
      rating: row.rating,
      title: row.title,
      body: row.body,
      sizeBought: row.size_bought,
      fit: row.fit_feedback,
      status: row.approved ? 'approved' : row.rejected ? 'rejected' : 'pending',
      adminReply: row.admin_reply,
      createdAt: new Date(row.created_at).toISOString(),
    }),
  );
}

export interface Decision {
  productId: string;
  changed: boolean;
  from: 'pending' | 'approved' | 'rejected';
  to: 'approved' | 'rejected';
}

/**
 * Serialises everything that changes which reviews of ONE product are approved, and recomputes its counters.
 * Per REVIEW is not enough: two moderators deciding DIFFERENT reviews of one product would each recompute from a
 * snapshot taken before the other committed, and the second would overwrite the counters without the first
 * decision. The lock is per product and is taken before the review row is read or changed; each statement after
 * it sees what the previous holder committed (READ COMMITTED).
 */
async function lockProductReviews(tx: Tx, productId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review-product:${productId}`}, 0))`,
  );
}

/** Approve or refuse. Returns what changed so the action can audit and invalidate the product's cache. */
export async function decideReview(
  tx: Tx,
  moderatorUserId: string,
  input: z.output<typeof reviewDecisionSchema>,
): Promise<Decision> {
  const [header] = await tx
    .select({ productId: reviews.productId })
    .from(reviews)
    .where(eq(reviews.id, input.id));
  if (header === undefined) throw new AdminNotFoundError('review');
  await lockProductReviews(tx, header.productId);
  const [row] = await tx
    .select({
      productId: reviews.productId,
      approved: reviews.isApproved,
      rejectedAt: reviews.rejectedAt,
    })
    .from(reviews)
    .where(eq(reviews.id, input.id));
  if (row === undefined) throw new AdminNotFoundError('review');
  const from = row.approved ? 'approved' : row.rejectedAt === null ? 'pending' : 'rejected';
  const to = input.decision === 'approve' ? 'approved' : 'rejected';
  if (from === to) return { productId: row.productId, changed: false, from, to };
  await tx
    .update(reviews)
    .set(
      to === 'approved'
        ? { isApproved: true, rejectedAt: null, moderatedByUserId: moderatorUserId }
        : { isApproved: false, rejectedAt: sql`now()`, moderatedByUserId: moderatorUserId },
    )
    .where(eq(reviews.id, input.id));
  await recomputeProductAggregates(tx, row.productId);
  return { productId: row.productId, changed: true, from, to };
}

/** Sets or clears the shop's reply. `changed` is false when the text is the same as before. */
export async function replyToReview(
  tx: Tx,
  moderatorUserId: string,
  input: z.output<typeof reviewReplySchema>,
): Promise<{ productId: string; changed: boolean }> {
  const [row] = await tx
    .select({ productId: reviews.productId, reply: reviews.adminReply })
    .from(reviews)
    .where(eq(reviews.id, input.id));
  if (row === undefined) throw new AdminNotFoundError('review');
  if ((row.reply ?? null) === input.reply) return { productId: row.productId, changed: false };
  await tx
    .update(reviews)
    .set({ adminReply: input.reply, moderatedByUserId: moderatorUserId })
    .where(eq(reviews.id, input.id));
  return { productId: row.productId, changed: true };
}
