import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ConfirmForm } from '@/components/newsletter/confirm-form';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/newsletter/confirm'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'newsletter' });
  return {
    title: t('confirmTitle'),
    robots: { index: false, follow: false },
    // The link carries a signed id in its query: no referrer may leak it.
    referrer: 'no-referrer',
  };
}

/** The confirmation link of the newsletter. Opening it changes nothing (a mail scanner may fetch it): the button POSTs. */
export default async function UnsubscribePage({ params, searchParams }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const raw = (await searchParams)['t'];
  const token = typeof raw === 'string' ? raw : '';
  const t = await getTranslations('newsletter');
  return (
    <SiteShell locale={locale} path={paths.newsletterConfirm} degrade>
      <h1 className="font-display text-3xl">{t('confirmTitle')}</h1>
      <p className="mb-6 mt-2 text-text-muted">{t('confirmIntro')}</p>
      {token === '' ? <p>{t('confirmError.invalid')}</p> : <ConfirmForm token={token} />}
    </SiteShell>
  );
}
