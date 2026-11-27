import { listPromoScopeCategories } from '@store/core/promo-admin';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { PromoForm } from '@/components/admin/promo-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function NewPromoCodePage() {
  await requirePermission('promo.manage');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.promo' });
  const rows = await listPromoScopeCategories(await getDb());
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('createTitle')}</h1>
      <div className="mt-4">
        <PromoForm
          categories={rows.map((c) => ({ id: c.id, name: locale === 'en' ? c.nameEn : c.nameUk }))}
        />
      </div>
    </div>
  );
}
