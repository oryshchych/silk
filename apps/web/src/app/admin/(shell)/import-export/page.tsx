import { exportParts } from '@store/core/admin-export';
import { can } from '@store/core/auth-permissions';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { ImportPanel } from '@/components/admin/import-panel';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function ImportExportPage() {
  const session = await requireFullSession();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.importExport' });
  const canImport = can(session.role, 'catalog.import');
  const canExport = can(session.role, 'catalog.export');
  const parts = canExport ? await exportParts(await getDb()) : [];
  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {canExport ? (
        <section aria-labelledby="export" className="space-y-2">
          <h2 id="export" className="text-lg font-semibold">
            {t('exportTitle')}
          </h2>
          <p className="text-text-muted">{t('exportHint')}</p>
          <a
            href="/admin/export/products"
            download
            className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 font-medium text-accent-contrast"
          >
            {t('exportCsv')}
          </a>
          {parts.length > 0 ? (
            <div className="space-y-2">
              <p role="status">{t('exportParts', { count: parts.length })}</p>
              <ul className="flex flex-wrap gap-3">
                {parts.map((after, index) => (
                  <li key={after ?? 'first'}>
                    <a
                      href={
                        after === null
                          ? '/admin/export/products'
                          : `/admin/export/products?after=${encodeURIComponent(after)}`
                      }
                      download
                      className="inline-flex min-h-11 items-center underline"
                    >
                      {t('exportPart', { number: index + 1 })}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
      {canImport ? <ImportPanel /> : null}
      {!canImport && !canExport ? <p>{t('noAccess')}</p> : null}
    </div>
  );
}
