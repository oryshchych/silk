import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { BannerForm } from '@/components/admin/banner-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';

export default async function NewBannerPage() {
  await requirePermission('banners.edit');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.banners' });
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('createTitle')}</h1>
      <div className="mt-4">
        <BannerForm />
      </div>
    </div>
  );
}
