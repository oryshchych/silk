'use server';

import {
  decideReview,
  replyToReview,
  reviewDecisionSchema,
  reviewReplySchema,
} from '@store/core/reviews-moderation';
import { productTag } from '@store/shared/cache-tags';

import { adminAction } from '@/lib/admin/bound-action';
import { invalidateTags } from '@/lib/admin/invalidate';

/**
 * Approve or refuse a review: `reviews.moderate`, checked by `adminAction` before the input is parsed.
 * The product's counters are recomputed in the same transaction, one audit row names the decision (never
 * the review text), and the product's cached page is dropped only AFTER the commit. A repeat decision
 * changes nothing and writes no audit row.
 */
export async function decideReviewAction(input: unknown) {
  const result = await adminAction({
    permission: 'reviews.moderate',
    schema: reviewDecisionSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await decideReview(tx, session.userId, parsed);
      if (!done.changed) {
        skipAudit();
        return { changed: false, productId: done.productId };
      }
      await audit({
        action: parsed.decision === 'approve' ? 'review.approved' : 'review.rejected',
        entity: 'review',
        entityId: parsed.id,
        diff: { from: done.from, to: done.to },
      });
      return { changed: true, productId: done.productId };
    },
  });
  if (result.ok && result.data.changed) invalidateTags([productTag(result.data.productId)]);
  return result;
}

export async function replyToReviewAction(input: unknown) {
  const result = await adminAction({
    permission: 'reviews.moderate',
    schema: reviewReplySchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      const done = await replyToReview(tx, session.userId, parsed);
      // The reply text is shown on the product page, not copied into the audit row.
      await audit({
        action: 'review.replied',
        entity: 'review',
        entityId: parsed.id,
        diff: { reply: parsed.reply === null ? 'removed' : 'set' },
      });
      return { changed: true, productId: done.productId };
    },
  });
  if (result.ok) invalidateTags([productTag(result.data.productId)]);
  return result;
}
