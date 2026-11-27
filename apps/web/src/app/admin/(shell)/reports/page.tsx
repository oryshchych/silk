import { mayRunReport } from '@store/core/reports';
import { reportNames } from '@store/shared/dto/reports';
import { getMessages } from 'next-intl/server';
import { cookies } from 'next/headers';

import { makeTranslator } from '@/lib/admin/message-lookup';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';

/** The list of reports the signed-in role may open (a report it may not open is not listed at all). */
export default async function ReportsIndexPage() {
  const session = await requirePermission('reports.view');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = makeTranslator(await getMessages({ locale }), 'admin.reports');
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-2 text-text-muted">{t('intro')}</p>
      <ul className="mt-4 space-y-3">
        {reportNames
          .filter((name) => mayRunReport(session.role, name))
          .map((name) => (
            <li key={name}>
              <a
                href={`/admin/reports/${name}`}
                className="inline-flex min-h-11 items-center underline"
              >
                {t(`names.${name}`)}
              </a>
              <p className="text-text-muted">{t(`descriptions.${name}`)}</p>
            </li>
          ))}
      </ul>
    </>
  );
}
