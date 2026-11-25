import { listAdminCategories } from '@store/core/admin-read';
import { can } from '@store/core/auth-permissions';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { CategoriesPanel } from '@/components/admin/categories-panel';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function AdminCategoriesPage() {
  const session = await requireFullSession();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.taxonomy' });
  const rows = await listAdminCategories(await getDb());
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">{t('categories')}</h1>
      <CategoriesPanel
        canEdit={can(session.role, 'categories.edit')}
        rows={rows.map((row) => ({
          id: row.id,
          parentId: row.parentId,
          slug: row.slug,
          nameUk: row.nameUk,
          nameEn: row.nameEn,
          depth: row.depth,
          sortOrder: row.sortOrder,
          isActive: row.isActive,
        }))}
      />
    </>
  );
}
