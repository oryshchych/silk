import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AccountFrame } from '@/components/account/account-frame';
import { resolveLocale } from '@/i18n/locale';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return { title: `${t('title')} | ${tm('siteName')}`, robots: { index: false, follow: false } };
}

/** Per request and per person: it reads the session, so it is never part of the shared page cache. */
export default async function AccountPage({ params }: Props) {
  return (
    <AccountFrame rawLocale={(await params).locale} path={paths.account} title={(t) => t('title')}>
      {({ customer }) => <p className="text-text-muted">{customer.email}</p>}
    </AccountFrame>
  );
}
