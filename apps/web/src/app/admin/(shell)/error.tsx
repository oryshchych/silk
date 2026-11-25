'use client';

import { useTranslations } from 'next-intl';

export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('admin.state');
  return (
    <div role="alert" className="space-y-3">
      <h1 className="text-xl font-semibold">{t('errorTitle')}</h1>
      <button
        type="button"
        onClick={reset}
        className="min-h-11 min-w-11 rounded-md border border-border px-3"
      >
        {t('errorRetry')}
      </button>
    </div>
  );
}
