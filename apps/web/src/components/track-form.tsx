'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import { trackOrderAction, type TrackResult } from '@/actions/track';
import { OrderDetails } from '@/components/order-details';
import { messageCode } from '@/lib/error-codes';
import { fieldText } from '@/lib/form-text';

const FIELD = 'min-h-10 rounded-sm border border-border bg-surface px-3';

/** Order number plus phone. Both travel in a POST body; the answer for a wrong number or phone is the same. */
export function TrackForm({ locale }: { locale: 'uk' | 'en' }) {
  const t = useTranslations('order');
  const te = useTranslations('errors.codes');
  const numberId = useId();
  const phoneId = useId();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<TrackResult | null>(null);

  function submit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    start(async () => {
      setResult(
        await trackOrderAction({
          orderNumber: fieldText(form, 'orderNumber'),
          phone: fieldText(form, 'phone'),
        }),
      );
    });
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor={numberId} className="flex flex-col gap-1 text-sm">
          {t('trackNumber')}
          <input
            id={numberId}
            name="orderNumber"
            required
            placeholder={t('trackNumberExample')}
            className={FIELD}
          />
        </label>
        <label htmlFor={phoneId} className="flex flex-col gap-1 text-sm">
          {t('trackPhone')}
          <input
            id={phoneId}
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            className={FIELD}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-full bg-accent px-6 text-accent-contrast disabled:opacity-50"
        >
          {t('trackSubmit')}
        </button>
      </form>
      <div aria-live="polite">
        {result === null ? null : result.ok ? (
          <OrderDetails order={result.order} locale={locale} />
        ) : (
          <p role="alert" className="text-danger">
            {te(messageCode(result.code))}
          </p>
        )}
      </div>
    </div>
  );
}
