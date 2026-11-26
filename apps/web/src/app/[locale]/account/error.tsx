'use client';

import { useTranslations } from 'next-intl';

export default function AccountError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('account');
  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6">
      <p role="alert">{t('error.error')}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 min-h-11 rounded-full border border-border px-6"
      >
        {t('retry')}
      </button>
    </main>
  );
}
