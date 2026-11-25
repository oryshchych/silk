import {
  listAdminAttributes,
  listAdminColorsFull,
  listAdminSizesFull,
} from '@store/core/admin-read';
import { can } from '@store/core/auth-permissions';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { DictionariesPanel } from '@/components/admin/dictionaries-panel';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function AdminDictionariesPage() {
  const session = await requireFullSession();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.taxonomy' });
  const db = await getDb();
  const [colors, sizes, attributes] = await Promise.all([
    listAdminColorsFull(db),
    listAdminSizesFull(db),
    listAdminAttributes(db),
  ]);
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">{t('dictionaries')}</h1>
      <DictionariesPanel
        colors={colors}
        sizes={sizes}
        attributes={attributes}
        canEdit={can(session.role, 'dictionaries.edit')}
      />
    </>
  );
}
