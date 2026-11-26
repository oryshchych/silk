/**
 * Moderation (admin, `reviews.moderate`). Approve, refuse and reply; every change recomputes the product's
 * counters (`rating_avg`, `reviews_count`, `fit_true_count`, `fit_total_count`) from the APPROVED rows in the
 * same transaction, so the numbers the page and the JSON-LD show can never drift from the visible
 * reviews. A refused review stays (the buyer cannot resubmit it) but is never shown.
 */
import { and, eq, sql } from 'drizzle-orm';
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
    .transform((value) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim())
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
    email: string;
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
    sql`SELECT r.id, r.product_id, p.name_uk AS name, p.slug, c.email, r.rating, r.title, r.body, r.size_bought,
               r.fit_feedback, r.is_approved AS approved, r.rejected_at IS NOT NULL AS rejected, r.admin_reply, r.created_at
          FROM reviews r JOIN products p ON p.id = r.product_id JOIN customers c ON c.id = r.customer_id
         WHERE ${condition} ORDER BY r.created_at, r.id LIMIT ${limit}`,
  );
  return result.rows.map((row) =>
    serialize(adminReviewDto, {
      id: row.id,
      productId: row.product_id,
      productName: row.name,
      productSlug: row.slug,
      customerEmail: row.email,
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

/** Approve or refuse. Returns what changed so the action can audit and invalidate the product's cache. */
export async function decideReview(
  tx: Tx,
  moderatorUserId: string,
  input: z.output<typeof reviewDecisionSchema>,
): Promise<Decision> {
  // One moderator at a time per review: two decisions on one review queue, they do not interleave.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review-decision:${input.id}`}, 0))`,
  );
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

export async function replyToReview(
  tx: Tx,
  moderatorUserId: string,
  input: z.output<typeof reviewReplySchema>,
): Promise<{ productId: string }> {
  const updated = await tx
    .update(reviews)
    .set({ adminReply: input.reply, moderatedByUserId: moderatorUserId })
    .where(and(eq(reviews.id, input.id)))
    .returning({ productId: reviews.productId });
  const row = updated[0];
  if (row === undefined) throw new AdminNotFoundError('review');
  return { productId: row.productId };
}
