import { listReturns } from '@store/core/returns-admin';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

const FILTERS = ['open', 'done'] as const;
const filterSchema = z.enum(FILTERS).catch('open');

export default async function AdminReturnsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('returns.manage');
  const raw = (await searchParams)['status'];
  const filter = filterSchema.parse(typeof raw === 'string' ? raw : undefined);
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.returns' });
  const rows = await listReturns(await getDb(), filter);
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <nav aria-label={t('filter')} className="mt-3 flex gap-4">
        {FILTERS.map((status) => (
          <a
            key={status}
            href={`/admin/returns?status=${status}`}
            aria-current={status === filter ? 'page' : undefined}
            className="inline-flex min-h-11 items-center underline aria-[current=page]:font-semibold"
          >
            {t(`filters.${status}`)}
          </a>
        ))}
      </nav>
      {rows.length === 0 ? <p className="mt-4">{t('empty')}</p> : null}
      <ul className="mt-4 flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id}>
            <a
              href={`/admin/returns/${row.id}`}
              className="inline-flex min-h-11 items-center underline"
            >
              {row.requestNumber} · {row.orderNumber} · {t(`status.${row.status}`)} ·{' '}
              {row.createdAt.slice(0, 10)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
