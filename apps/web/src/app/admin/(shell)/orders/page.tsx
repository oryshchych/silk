import { listAdminOrders } from '@store/core/orders-admin-read';
import { deliveryMethodValues, paymentProviderValues } from '@store/shared/dto/admin-order';
import { orderStatusValues, paymentStatusValues } from '@store/shared/dto/order';
import { formatMoney, money } from '@store/shared/money';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { formatWhen } from '@/lib/admin/format';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

const day = z.iso.date();
// `.catch(undefined)`: a garbled filter in the address is ignored, never a 500.
const searchSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.enum(orderStatusValues).optional().catch(undefined),
  pay: z.enum(paymentStatusValues).optional().catch(undefined),
  provider: z.enum(paymentProviderValues).optional().catch(undefined),
  method: z.enum(deliveryMethodValues).optional().catch(undefined),
  from: day.optional().catch(undefined),
  to: day.optional().catch(undefined),
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
  return query === '' ? '/admin/orders' : `/admin/orders?${query}`;
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('orders.view');
  const raw = await searchParams;
  const parsed = searchSchema.parse(
    Object.fromEntries(
      ['q', 'status', 'pay', 'provider', 'method', 'from', 'to', 'page'].map((key) => [
        key,
        one(raw[key]),
      ]),
    ),
  );
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.orders' });
  const result = await listAdminOrders(await getDb(), {
    q: parsed.q,
    status: parsed.status,
    paymentStatus: parsed.pay,
    paymentProvider: parsed.provider,
    deliveryMethod: parsed.method,
    from: parsed.from,
    to: parsed.to,
    page: parsed.page,
  });
  const base = {
    q: parsed.q,
    status: parsed.status,
    pay: parsed.pay,
    provider: parsed.provider,
    method: parsed.method,
    from: parsed.from,
    to: parsed.to,
  };
  const header = 'px-3 py-2 text-left font-medium';
  const cell = 'px-3 py-2 align-top';
  const field = 'mt-1 block min-h-11 rounded-md border border-border bg-surface px-3';
  const select = (
    name: 'status' | 'pay' | 'provider' | 'method',
    label: string,
    options: { value: string; text: string }[],
    current?: string,
  ) => (
    <label className="block">
      {label}
      <select name={name} defaultValue={current ?? ''} className={field}>
        <option value="">{t('any')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.text}
          </option>
        ))}
      </select>
    </label>
  );
  const statusOptions = orderStatusValues.map((value) => ({ value, text: t(`status.${value}`) }));
  const payOptions = paymentStatusValues.map((value) => ({ value, text: t(`pay.${value}`) }));
  const providerOptions = paymentProviderValues.map((value) => ({
    value,
    text: t(`provider.${value}`),
  }));
  const methodOptions = deliveryMethodValues.map((value) => ({
    value,
    text: t(`method.${value}`),
  }));
  const columns = [
    ['number', t('col.number')],
    ['date', t('col.date')],
    ['customer', t('col.customer')],
    ['status', t('col.status')],
    ['payment', t('col.payment')],
    ['items', t('col.items')],
    ['sum', t('col.sum')],
    ['ttn', t('col.ttn')],
  ] as const;
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <form method="get" role="search" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          {t('search')}
          <input name="q" defaultValue={parsed.q ?? ''} maxLength={100} className={field} />
        </label>
        {select('status', t('filter.status'), statusOptions, parsed.status)}
        {select('pay', t('filter.payment'), payOptions, parsed.pay)}
        {select('provider', t('filter.provider'), providerOptions, parsed.provider)}
        {select('method', t('filter.delivery'), methodOptions, parsed.method)}
        <label className="block">
          {t('from')}
          <input type="date" name="from" defaultValue={parsed.from ?? ''} className={field} />
        </label>
        <label className="block">
          {t('to')}
          <input type="date" name="to" defaultValue={parsed.to ?? ''} className={field} />
        </label>
        <button
          type="submit"
          className="min-h-11 min-w-11 rounded-md bg-accent px-4 font-medium text-accent-contrast"
        >
          {t('submit')}
        </button>
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
                {columns.map(([key, label]) => (
                  <th key={key} scope="col" className={header}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.items.map((row) => (
                <tr key={row.id} className="border-b border-border">
                  <td className={cell}>
                    <a
                      className="inline-flex min-h-11 items-center underline"
                      href={`/admin/orders/${row.id}`}
                    >
                      {row.orderNumber}
                    </a>
                  </td>
                  <td className={cell}>{formatWhen(row.createdAt, locale)}</td>
                  <td className={cell}>
                    {row.customerName}
                    <br />
                    <span className="text-text-muted">{row.customerPhone}</span>
                  </td>
                  <td className={cell}>{t(`status.${row.status}`)}</td>
                  <td className={cell}>{t(`pay.${row.paymentStatus}`)}</td>
                  <td className={cell}>{row.itemCount}</td>
                  <td className={cell}>{formatMoney(money(row.total), locale)}</td>
                  <td className={cell}>{row.ttn ?? '—'}</td>
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
