import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { SiteShell } from '@/components/site-shell';
import { TrackForm } from '@/components/track-form';
import { resolveLocale } from '@/i18n/locale';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/order/track'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'order' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: `${t('trackTitle')} | ${tm('siteName')}`,
    robots: { index: false, follow: false },
  };
}

export default async function OrderTrackPage({ params }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const t = await getTranslations('order');
  return (
    <SiteShell locale={locale} path={paths.orderTrack} degrade>
      <h1 className="font-display text-3xl">{t('trackTitle')}</h1>
      <p className="mb-6 mt-2 text-text-muted">{t('trackIntro')}</p>
      <TrackForm locale={locale} />
    </SiteShell>
  );
}
