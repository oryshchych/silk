import { listMyAddresses } from '@store/core/account-addresses';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AccountFrame } from '@/components/account/account-frame';
import { AddressBook } from '@/components/account/address-book';
import { resolveLocale } from '@/i18n/locale';
import { getDb } from '@/lib/db';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account/addresses'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return { title: t('section.addresses'), robots: { index: false, follow: false } };
}

export default async function AccountAddressesPage({ params }: Props) {
  return (
    <AccountFrame
      rawLocale={(await params).locale}
      path={paths.accountAddresses}
      title={(t) => t('section.addresses')}
    >
      {async ({ customer }) => (
        <AddressBook addresses={await listMyAddresses(await getDb(), customer.customerId)} />
      )}
    </AccountFrame>
  );
}
