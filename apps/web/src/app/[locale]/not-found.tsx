import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-display text-3xl">{t('notFoundTitle')}</h1>
      <p className="text-text-muted">{t('notFoundText')}</p>
      <Link
        href="/"
        className="rounded-full border border-border px-5 py-2 hover:bg-surface-raised"
      >
        {t('backHome')}
      </Link>
    </main>
  );
}
