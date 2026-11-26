import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { CredentialPage } from '@/components/account/account-page';
import { resolveLocale } from '@/i18n/locale';

type Props = PageProps<'/[locale]/account/set-password'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: `${t('setPasswordTitle')} | ${tm('siteName')}`,
    robots: { index: false, follow: false },
    // The link carries a credential in its query: no referrer may leak it to another site.
    referrer: 'no-referrer',
  };
}

/** Opening the link changes nothing (a mail scanner may fetch it): the token is used by the POST only. */
export default async function SetPasswordPage({ params, searchParams }: Props) {
  const raw = (await searchParams)['t'];
  const token = typeof raw === 'string' ? raw : undefined;
  return <CredentialPage rawLocale={(await params).locale} kind="setPassword" token={token} />;
}
