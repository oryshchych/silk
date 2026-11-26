'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { decideReviewAction, replyToReviewAction } from '@/actions/admin-reviews';
import type { AdminReviewDto } from '@store/shared/dto/review';

import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

/** One review with the moderator's buttons. The text is rendered as text nodes (escaped), never as HTML. */
export function ReviewModeration({ review }: { review: AdminReviewDto }) {
  const t = useTranslations('admin.reviews');
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  const button = 'min-h-11 min-w-11 rounded-md border border-border px-4 disabled:opacity-60';
  const decide = (decision: 'approve' | 'reject') => {
    run(
      async () => await decideReviewAction({ id: review.id, decision }),
      t('saved'),
      () => {
        router.refresh();
      },
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-muted">
        {review.productName} · {review.customerEmail} · {review.createdAt.slice(0, 10)}
        {review.sizeBought === null ? '' : ` · ${review.sizeBought}`}
      </p>
      <p className="font-medium">
        {'★'.repeat(review.rating)}
        {'☆'.repeat(5 - review.rating)} {review.title}
      </p>
      {review.body === null ? null : <p className="whitespace-pre-line">{review.body}</p>}
      <div className="flex flex-wrap gap-2">
        {review.status === 'approved' ? null : (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              decide('approve');
            }}
            className={button}
          >
            {t('approve')}
          </button>
        )}
        {review.status === 'rejected' ? null : (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              decide('reject');
            }}
            className={button}
          >
            {t('reject')}
          </button>
        )}
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const data = readForm(event.currentTarget);
          run(
            async () => await replyToReviewAction({ id: review.id, reply: textOf(data, 'reply') }),
            t('saved'),
            () => {
              router.refresh();
            },
          );
        }}
      >
        <label className="block text-sm">
          {t('reply')}
          <textarea
            name="reply"
            defaultValue={review.adminReply ?? ''}
            maxLength={2000}
            rows={2}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2"
          />
        </label>
        <button type="submit" disabled={pending} className={`${button} w-fit`}>
          {t('saveReply')}
        </button>
      </form>
      <StatusLine message={message} />
    </div>
  );
}
