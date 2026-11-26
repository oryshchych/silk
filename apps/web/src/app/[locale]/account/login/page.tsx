import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { CredentialPage } from '@/components/account/account-page';
import { resolveLocale } from '@/i18n/locale';

type Props = PageProps<'/[locale]/account/login'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: `${t('loginTitle')} | ${tm('siteName')}`,
    robots: { index: false, follow: false },
  };
}

export default async function Page({ params, searchParams }: Props) {
  return (
    <CredentialPage
      rawLocale={(await params).locale}
      kind="login"
      notice={(await searchParams)['done'] === '1'}
    />
  );
}
