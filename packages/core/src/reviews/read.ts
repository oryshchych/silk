/**
 * What the storefront shows: APPROVED reviews only (the query filters on `is_approved`, so nothing
 * pending or refused can reach a cached page), the fit summary computed from the same approved rows,
 * and the author as first name plus the initial of the last name. Never an e-mail, an id or an order.
 */
import { sql } from 'drizzle-orm';

import type { Reader } from '@store/db/types';
import {
  fitSummaryDto,
  publicReviewDto,
  type FitSummaryDto,
  type PublicReviewDto,
} from '@store/shared/dto/review';
import { serialize } from '@store/shared/dto/serialize';

export const PUBLIC_REVIEW_LIMIT = 10;

/** `Iryna K.`, or null when the customer has no first name. The surname is cut to its initial. */
export function displayName(first: string | null, last: string | null): string | null {
  const name = first?.trim().replace(/\s+/g, ' ') ?? '';
  if (name === '') return null;
  const code = (last?.trim() ?? '').codePointAt(0);
  return code === undefined ? name : `${name} ${String.fromCodePoint(code).toUpperCase()}.`;
}

export async function listApprovedReviews(
  reader: Reader,
  productId: string,
  limit = PUBLIC_REVIEW_LIMIT,
): Promise<PublicReviewDto[]> {
  const result = await reader.execute<{
    rating: number;
    title: string | null;
    body: string | null;
    first_name: string | null;
    last_name: string | null;
    created_at: Date;
    size_bought: string | null;
    fit_feedback: string | null;
    admin_reply: string | null;
  }>(
    sql`SELECT r.rating, r.title, r.body, c.first_name, c.last_name, r.created_at, r.size_bought,
               r.fit_feedback, r.admin_reply
          FROM reviews r JOIN customers c ON c.id = r.customer_id
         WHERE r.product_id = ${productId}::uuid AND r.is_approved
         ORDER BY r.created_at DESC, r.id
         LIMIT ${limit}`,
  );
  return result.rows.map((row) =>
    serialize(publicReviewDto, {
      rating: row.rating,
      title: row.title,
      body: row.body,
      author: displayName(row.first_name, row.last_name),
      createdAt: new Date(row.created_at).toISOString(),
      sizeBought: row.size_bought,
      fit: row.fit_feedback,
      adminReply: row.admin_reply,
    }),
  );
}

/** "68% say it fits": from the counters the moderation keeps in step with the approved rows; null without fit data. */
export function fitSummary(trueCount: number, totalCount: number): FitSummaryDto | null {
  if (totalCount <= 0) return null;
  return serialize(fitSummaryDto, {
    truePercent: Math.round((trueCount / totalCount) * 100),
    total: totalCount,
  });
}
