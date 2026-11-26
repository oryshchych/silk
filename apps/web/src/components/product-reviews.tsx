import { getTranslations } from 'next-intl/server';

import type { FitSummaryDto, PublicReviewDto } from '@store/shared/dto/review';

/**
 * Approved reviews on the product page. Server-rendered from the cached product read (which carries
 * approved rows only), so the same HTML serves everyone and nothing here depends on the visitor. Every
 * user text is rendered as a React text node (escaped), never as HTML. `data-review-count` lets a
 * check compare the visible count with the structured data.
 */
export async function ProductReviews({
  average,
  count,
  fit,
  reviews,
  locale,
}: {
  average: number | null;
  count: number;
  fit: FitSummaryDto | null;
  reviews: PublicReviewDto[];
  locale: 'uk' | 'en';
}) {
  const t = await getTranslations('product.reviews');
  if (count === 0 || average === null) return null;
  const oneDecimal = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'uk-UA', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const date = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'uk-UA', {
    dateStyle: 'medium',
    timeZone: 'Europe/Kyiv',
  });
  return (
    <section aria-labelledby="reviews-h" className="mt-10" data-review-count={count}>
      <h2 id="reviews-h" className="font-display text-2xl">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm">{t('summary', { rating: oneDecimal.format(average), count })}</p>
      {fit === null ? null : (
        <p className="text-sm text-text-muted">
          {t('fit', { percent: fit.truePercent, total: fit.total })}
        </p>
      )}
      <ul className="mt-4 flex flex-col gap-4">
        {reviews.map((review) => (
          <li
            key={`${review.createdAt}-${review.author ?? ''}-${review.title ?? ''}`}
            className="border-t border-border pt-3"
          >
            <p className="text-sm font-medium">
              <span aria-label={t('stars', { rating: review.rating })}>
                {'★'.repeat(review.rating)}
                {'☆'.repeat(5 - review.rating)}
              </span>
              {review.title === null ? null : <> {review.title}</>}
            </p>
            {review.body === null ? null : (
              <p className="mt-1 whitespace-pre-line text-sm">{review.body}</p>
            )}
            <p className="mt-1 text-xs text-text-muted">
              {[
                review.author ?? t('verifiedBuyer'),
                date.format(new Date(review.createdAt)),
                review.sizeBought === null ? null : t('size', { size: review.sizeBought }),
              ]
                .filter((part): part is string => part !== null)
                .join(' · ')}
            </p>
            {review.adminReply === null ? null : (
              <p className="mt-2 rounded-sm bg-surface-raised p-2 text-sm">
                <span className="font-medium">{t('reply')}</span> {review.adminReply}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
