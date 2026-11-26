import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { UnsubscribeForm } from '@/components/account/unsubscribe-form';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/unsubscribe'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return {
    title: t('unsubscribeTitle'),
    robots: { index: false, follow: false },
    // The link carries a signed id in its query: no referrer may leak it.
    referrer: 'no-referrer',
  };
}

/** Opening the link changes nothing (a mail scanner may fetch it): the button POSTs. */
export default async function UnsubscribePage({ params, searchParams }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const raw = (await searchParams)['t'];
  const token = typeof raw === 'string' ? raw : '';
  const t = await getTranslations('account');
  return (
    <SiteShell locale={locale} path={paths.unsubscribe} degrade>
      <h1 className="font-display text-3xl">{t('unsubscribeTitle')}</h1>
      <p className="mb-6 mt-2 text-text-muted">{t('unsubscribeIntro')}</p>
      {token === '' ? <p>{t('error.invalid')}</p> : <UnsubscribeForm token={token} />}
    </SiteShell>
  );
}
