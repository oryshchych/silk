import { listAdminCategories } from '@store/core/admin-read';
import { can } from '@store/core/auth-permissions';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { ProductCreateForm } from '@/components/admin/product-create-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function NewProductPage() {
  const session = await requireFullSession();
  // The action checks `catalog.create` again; this only keeps the page from showing a dead form.
  if (!can(session.role, 'catalog.create')) redirect('/admin/products');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.editor' });
  const categories = await listAdminCategories(await getDb());
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">{t('newTitle')}</h1>
      <ProductCreateForm
        categories={categories.map((category) => ({
          value: category.id,
          label: `${'— '.repeat(category.depth)}${locale === 'en' ? category.nameEn : category.nameUk}`,
        }))}
        canSetCost={can(session.role, 'catalog.cost.view')}
      />
    </>
  );
}
