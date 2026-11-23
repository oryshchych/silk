import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { resolveLocale } from '@/i18n/locale';
import type { Locale } from '@/i18n/routing';
import { getSiteUrl } from '@/lib/site-url';
import { buildAlternates, localizedPath } from '@store/shared/seo';

export async function generateMetadata({ params }: PageProps<'/[locale]'>): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  return { alternates: buildAlternates({ siteUrl: await getSiteUrl(), locale, path: '/' }) };
}

export default async function HomePage({ params }: PageProps<'/[locale]'>) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const t = await getTranslations('home');
  const otherLocale: Locale = locale === 'uk' ? 'en' : 'uk';
  const otherHref = localizedPath(otherLocale, '/');

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="font-display text-4xl tracking-wide">{t('brand')}</h1>
      <p className="text-lg">{t('tagline')}</p>
      <p className="text-text-muted">{t('comingSoon')}</p>
      <Link
        href={otherHref}
        hrefLang={otherLocale}
        className="rounded-full border border-border px-5 py-2 hover:bg-surface-raised"
      >
        {t('switchLanguage')}
      </Link>
    </main>
  );
}
