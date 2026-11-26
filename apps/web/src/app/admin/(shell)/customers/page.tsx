import { can } from '@store/core/auth-permissions';
import { listCustomers } from '@store/core/customers-admin-read';
import { customerSegmentValues } from '@store/shared/dto/admin-customer';
import { formatMoney, money } from '@store/shared/money';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { formatWhen } from '@/lib/admin/format';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

// `.catch(undefined)`: a garbled filter in the address is ignored, never a 500.
const searchSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  segment: z.enum(customerSegmentValues).optional().catch(undefined),
  tag: z.string().trim().max(30).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
});

const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

function toQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined || value === '' ? [] : [[key, value]],
    ),
  ).toString();
  return query === '' ? '/admin/customers' : `/admin/customers?${query}`;
}

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission('customers.view');
  const raw = await searchParams;
  const parsed = searchSchema.parse({
    q: one(raw['q']),
    segment: one(raw['segment']),
    tag: one(raw['tag']),
    page: one(raw['page']),
  });
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.customers' });
  const result = await listCustomers(await getDb(), parsed);
  const base = { q: parsed.q, segment: parsed.segment, tag: parsed.tag };
  const header = 'px-3 py-2 text-left font-medium';
  const cell = 'px-3 py-2 align-top';
  const field = 'mt-1 block min-h-11 rounded-md border border-border bg-surface px-3';
  const segmentOptions = customerSegmentValues.map((value) => ({
    value,
    text: t(`segment.${value}`),
  }));
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <form method="get" role="search" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          {t('search')}
          <input name="q" defaultValue={parsed.q ?? ''} maxLength={100} className={field} />
        </label>
        <label className="block">
          {t('segmentLabel')}
          <select name="segment" defaultValue={parsed.segment ?? ''} className={field}>
            <option value="">{t('any')}</option>
            {segmentOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.text}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          {t('tag')}
          <input name="tag" defaultValue={parsed.tag ?? ''} maxLength={30} className={field} />
        </label>
        <button
          type="submit"
          className="min-h-11 min-w-11 rounded-md bg-accent px-4 font-medium text-accent-contrast"
        >
          {t('submit')}
        </button>
        {can(session.role, 'customers.export') ? (
          <a className="inline-flex min-h-11 items-center underline" href="/admin/export/customers">
            {t('export')}
          </a>
        ) : null}
      </form>
      <p role="status" aria-live="polite" className="mt-4 text-text-muted">
        {t('total', { count: result.total })}
      </p>
      {result.items.length === 0 ? (
        <p className="mt-4">{t('empty')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t('title')}</caption>
            <thead>
              <tr className="border-b border-border">
                {[
                  t('col.customer'),
                  t('col.orders'),
                  t('col.ltv'),
                  t('col.last'),
                  t('col.segment'),
                  t('col.tags'),
                ].map((label) => (
                  <th key={label} scope="col" className={header}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.items.map((row) => (
                <tr key={row.key} className="border-b border-border">
                  <td className={cell}>
                    <a
                      className="inline-flex min-h-11 items-center underline"
                      href={`/admin/customers/${row.key}`}
                    >
                      {row.name}
                    </a>
                    <br />
                    <span className="text-text-muted">{row.email}</span>
                  </td>
                  <td className={cell}>{row.ordersCount}</td>
                  <td className={cell}>{formatMoney(money(row.ltv), locale)}</td>
                  <td className={cell}>{formatWhen(row.lastOrderAt, locale)}</td>
                  <td className={cell}>{t(`segment.${row.segment}`)}</td>
                  <td className={cell}>{row.tags.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label={t('pages')} className="mt-4 flex items-center gap-4">
        {result.page > 1 ? (
          <a
            className="inline-flex min-h-11 items-center underline"
            href={toQuery({ ...base, page: String(result.page - 1) })}
          >
            {t('previous')}
          </a>
        ) : null}
        <span>{t('pageOf', { page: result.page, total: result.totalPages })}</span>
        {result.page < result.totalPages ? (
          <a
            className="inline-flex min-h-11 items-center underline"
            href={toQuery({ ...base, page: String(result.page + 1) })}
          >
            {t('next')}
          </a>
        ) : null}
      </nav>
    </>
  );
}
