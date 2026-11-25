import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { SignOutOthers } from '@/components/admin/sign-out-others';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';

export default async function AdminDashboardPage() {
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.dashboard' });
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-2 text-text-muted">{t('welcome')}</p>
      <SignOutOthers />
    </>
  );
}
