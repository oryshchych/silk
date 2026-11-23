'use client';

import { useTranslations } from 'next-intl';

export default function LocaleError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('errors');
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-display text-3xl">{t('errorTitle')}</h1>
      <p role="alert" className="text-text-muted">
        {t('errorText')}
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-full border border-border px-5 py-2 hover:bg-surface-raised"
      >
        {t('retry')}
      </button>
    </main>
  );
}
