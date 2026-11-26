import { listStock } from '@store/core/admin-stock-read';
import { can } from '@store/core/auth-permissions';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { StockAdjustForm } from '@/components/admin/stock-adjust-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

const searchSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
  low: z.literal('1').optional().catch(undefined),
});

const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

function toQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined || value === '' ? [] : [[key, value]],
    ),
  ).toString();
  return query === '' ? '/admin/stock' : `/admin/stock?${query}`;
}

export default async function AdminStockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireFullSession();
  const raw = await searchParams;
  const parsed = searchSchema.parse({
    q: one(raw['q']),
    page: one(raw['page']),
    low: one(raw['low']),
  });
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.stock' });
  const result = await listStock(await getDb(), {
    q: parsed.q,
    page: parsed.page,
    lowOnly: parsed.low === '1',
  });
  const canAdjust = can(session.role, 'stock.adjust');
  const base = { q: parsed.q, low: parsed.low };
  const header = 'px-3 py-2 text-left font-medium';
  const cell = 'px-3 py-2 align-top';
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <form method="get" role="search" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          {t('search')}
          <input
            name="q"
            defaultValue={parsed.q ?? ''}
            maxLength={100}
            className="mt-1 block min-h-11 rounded-md border border-border bg-surface px-3"
          />
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" name="low" value="1" defaultChecked={parsed.low === '1'} />
          {t('lowOnly')}
        </label>
        <button
          type="submit"
          className="min-h-11 min-w-11 rounded-md bg-accent px-4 font-medium text-accent-contrast"
        >
          {t('filter')}
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
                <th scope="col" className={header}>
                  {t('product')}
                </th>
                <th scope="col" className={header}>
                  {t('variant')}
                </th>
                <th scope="col" className={header}>
                  {t('stock')}
                </th>
                <th scope="col" className={header}>
                  {t('reserved')}
                </th>
                <th scope="col" className={header}>
                  {t('available')}
                </th>
                {canAdjust ? (
                  <th scope="col" className={header}>
                    {t('adjust')}
                  </th>
                ) : null}
                <th scope="col" className={header}>
                  <span className="sr-only">{t('history')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((row) => {
                const label = `${row.sku} ${row.colorName} ${row.sizeLabel}`;
                return (
                  <tr key={row.variantId} className="border-b border-border">
                    <td className={cell}>
                      <a className="underline" href={`/admin/products/${row.productId}`}>
                        {row.productName}
                      </a>
                    </td>
                    <td className={cell}>{`${row.sku} · ${row.colorName} / ${row.sizeLabel}`}</td>
                    <td className={cell}>{row.stock}</td>
                    <td className={cell}>
                      {row.reserved > 0 ? (
                        <a
                          className="inline-flex min-h-11 items-center underline"
                          href={`/admin/stock/${row.variantId}`}
                        >
                          {row.reserved}
                        </a>
                      ) : (
                        row.reserved
                      )}
                    </td>
                    <td className={cell}>{row.available}</td>
                    {canAdjust ? (
                      <td className={cell}>
                        <StockAdjustForm variantId={row.variantId} label={label} />
                      </td>
                    ) : null}
                    <td className={cell}>
                      <a
                        className="inline-flex min-h-11 items-center underline"
                        href={`/admin/stock/${row.variantId}`}
                      >
                        {t('history')}
                      </a>
                    </td>
                  </tr>
                );
              })}
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
