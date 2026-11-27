import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { UnsubscribeForm } from '@/components/account/unsubscribe-form';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/unsubscribe/marketing'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return {
    title: t('marketingUnsubscribeTitle'),
    robots: { index: false, follow: false },
    // The link carries a signed id in its query: no referrer may leak it.
    referrer: 'no-referrer',
  };
}

/** The marketing-mail link. Opening it changes nothing (a mail scanner may fetch it): the button POSTs. */
export default async function UnsubscribePage({ params, searchParams }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const raw = (await searchParams)['t'];
  const token = typeof raw === 'string' ? raw : '';
  const t = await getTranslations('account');
  return (
    <SiteShell locale={locale} path={paths.unsubscribeMarketing} degrade>
      <h1 className="font-display text-3xl">{t('marketingUnsubscribeTitle')}</h1>
      <p className="mb-6 mt-2 text-text-muted">{t('marketingUnsubscribeIntro')}</p>
      {token === '' ? <p>{t('error.invalid')}</p> : <UnsubscribeForm token={token} marketing />}
    </SiteShell>
  );
}
