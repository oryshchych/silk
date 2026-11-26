'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import { submitReviewAction } from '@/actions/account-data';
import type { CustomerActionResult } from '@/lib/account/action';
import { fieldText } from '@/lib/form-text';

const FIELD = 'min-h-10 rounded-sm border border-border bg-surface px-3';
const RATINGS = [5, 4, 3, 2, 1] as const;
const FITS = ['small', 'true_to_size', 'large'] as const;
const FIT_KEYS = { small: 'fitSmall', true_to_size: 'fitTrue', large: 'fitLarge' } as const;

/** Rating, title, text and fit. The buyer's size is taken from the order on the server. */
export function ReviewForm({ productId }: { productId: string }) {
  const t = useTranslations('account');
  const ids = { title: useId(), body: useId() };
  const [pending, start] = useTransition();
  const [result, setResult] = useState<CustomerActionResult<string> | null>(null);
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const fit = fieldText(form, 'fit');
        start(async () => {
          setResult(
            await submitReviewAction({
              productId,
              rating: Number(fieldText(form, 'rating')),
              title: fieldText(form, 'title'),
              body: fieldText(form, 'body'),
              fit: fit === '' ? null : fit,
            }),
          );
        });
      }}
    >
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-1 text-sm">{t('rating')}</legend>
        {RATINGS.map((rating) => (
          <label key={rating} className="flex min-h-6 items-center gap-1 text-sm">
            <input type="radio" name="rating" value={String(rating)} required className="size-5" />
            {rating}
          </label>
        ))}
      </fieldset>
      <label htmlFor={ids.title} className="flex flex-col gap-1 text-sm">
        {t('reviewTitle')}
        <input id={ids.title} name="title" maxLength={120} className={FIELD} />
      </label>
      <label htmlFor={ids.body} className="flex flex-col gap-1 text-sm">
        {t('reviewBody')}
        <textarea id={ids.body} name="body" maxLength={2000} rows={4} className={`${FIELD} py-2`} />
      </label>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-1 text-sm">{t('fitQuestion')}</legend>
        {FITS.map((fit) => (
          <label key={fit} className="flex min-h-6 items-center gap-1 text-sm">
            <input type="radio" name="fit" value={fit} className="size-5" />
            {t(FIT_KEYS[fit])}
          </label>
        ))}
      </fieldset>
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 w-fit rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {t('reviewSubmit')}
      </button>
      <div aria-live="polite" className="min-h-6 text-sm">
        {result === null ? null : result.ok ? (
          <p>{t('reviewSent')}</p>
        ) : (
          <p className="text-danger">
            {t(
              result.code === 'invalid'
                ? 'reviewInvalid'
                : result.code === 'notFound'
                  ? 'reviewNotAllowed'
                  : 'error.error',
            )}
          </p>
        )}
      </div>
    </form>
  );
}
