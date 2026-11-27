'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { confirmNewsletterAction, type ConfirmNewsletterResult } from '@/actions/unsubscribe';

/** Opening the mailed link changes nothing (a mail scanner may fetch it): this button confirms. */
export function ConfirmForm({ token }: { token: string }) {
  const t = useTranslations('newsletter');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ConfirmNewsletterResult | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          start(async () => {
            setResult(await confirmNewsletterAction({ token }));
          });
        }}
        className="min-h-11 w-fit rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {t('confirmButton')}
      </button>
      <div aria-live="polite" className="min-h-6 text-sm">
        {result === null ? null : result.status === 'error' ? (
          <p className="text-danger">{t(`confirmError.${result.code}`)}</p>
        ) : (
          <p>{t('confirmed')}</p>
        )}
      </div>
    </div>
  );
}
