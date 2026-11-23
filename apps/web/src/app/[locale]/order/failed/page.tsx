import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { href, paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/order/failed'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'order' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: `${t('failedTitle')} | ${tm('siteName')}`,
    robots: { index: false, follow: false },
  };
}

/** Landing page for a payment that did not go through (card payments arrive with phase 3). */
export default async function OrderFailedPage({ params }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const t = await getTranslations('order');
  return (
    <SiteShell locale={locale} path={paths.orderFailed} degrade>
      <h1 className="font-display text-3xl">{t('failedTitle')}</h1>
      <p className="mt-3">{t('failedText')}</p>
      <Link href={href(locale, paths.checkout)} className="mt-4 inline-block underline">
        {t('failedRetry')}
      </Link>
    </SiteShell>
  );
}
