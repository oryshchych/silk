import { getProfile, listSaveableSizes } from '@store/core/account-profile';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AccountFrame } from '@/components/account/account-frame';
import { ProfileForms } from '@/components/account/profile-forms';
import { resolveLocale } from '@/i18n/locale';
import { getDb } from '@/lib/db';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account/profile'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return { title: t('section.profile'), robots: { index: false, follow: false } };
}

export default async function AccountProfilePage({ params }: Props) {
  return (
    <AccountFrame
      rawLocale={(await params).locale}
      path={paths.accountProfile}
      title={(t) => t('section.profile')}
    >
      {async ({ customer }) => {
        const db = await getDb();
        const profile = await getProfile(db, customer.customerId);
        if (profile === null) notFound();
        return <ProfileForms profile={profile} sizes={await listSaveableSizes(db)} />;
      }}
    </AccountFrame>
  );
}
