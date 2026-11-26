'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { unsubscribeStockAlertAction, type UnsubscribeResult } from '@/actions/unsubscribe';

export function UnsubscribeForm({ token }: { token: string }) {
  const t = useTranslations('account');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<UnsubscribeResult | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          start(async () => {
            setResult(await unsubscribeStockAlertAction({ token }));
          });
        }}
        className="min-h-11 w-fit rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {t('unsubscribeConfirm')}
      </button>
      <div aria-live="polite" className="min-h-6 text-sm">
        {result === null ? null : result.status === 'done' ? (
          <p>{t('unsubscribed')}</p>
        ) : (
          <p className="text-danger">
            {t(result.code === 'rateLimited' ? 'error.rateLimited' : 'error.invalid')}
          </p>
        )}
      </div>
    </div>
  );
}
