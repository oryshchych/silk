import { listAdminProducts } from '@store/core/admin-read';
import { can } from '@store/core/auth-permissions';
import { formatMoney, money } from '@store/shared/money';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { getDb } from '@/lib/db';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';

const STATE_ACTIVE = 'active';
const STATE_INACTIVE = 'inactive';

const searchSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
  state: z.enum(['active', 'inactive']).optional().catch(undefined),
  low: z.enum(['1']).optional().catch(undefined),
});

function toQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined || value === '' ? [] : [[key, value]],
    ),
  ).toString();
  return query === '' ? '/admin/products' : `/admin/products?${query}`;
}

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireFullSession();
  // The cost column exists only for a role that may see it; the data layer enforces the same
  // thing, so the page cannot show what the DTO does not carry.
  const canSeeCost = can(session.role, 'catalog.cost.view');
  const raw = await searchParams;
  const parsed = searchSchema.parse({
    q: typeof raw['q'] === 'string' ? raw['q'] : undefined,
    page: typeof raw['page'] === 'string' ? raw['page'] : undefined,
    state: typeof raw['state'] === 'string' ? raw['state'] : undefined,
    low: typeof raw['low'] === 'string' ? raw['low'] : undefined,
  });
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.products' });
  const result = await listAdminProducts(
    await getDb(),
    {
      q: parsed.q,
      page: parsed.page,
      isActive: parsed.state === undefined ? undefined : parsed.state === 'active',
      lowStock: parsed.low === '1',
    },
    canSeeCost,
  );
  const base = { q: parsed.q, state: parsed.state, low: parsed.low };
  const header = 'px-3 py-2 text-left font-medium';
  const cell = 'px-3 py-2 align-top';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        {can(session.role, 'catalog.create') ? (
          <a
            href="/admin/products/new"
            className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 font-medium text-accent-contrast"
          >
            {t('new')}
          </a>
        ) : null}
      </div>
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
        <label className="block">
          {t('state')}
          <select
            name="state"
            defaultValue={parsed.state ?? ''}
            className="mt-1 block min-h-11 rounded-md border border-border bg-surface px-3"
          >
            <option value="">{t('stateAll')}</option>
            <option value={STATE_ACTIVE}>{t('stateActive')}</option>
            <option value={STATE_INACTIVE}>{t('stateInactive')}</option>
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" name="low" value="1" defaultChecked={parsed.low === '1'} />
          {t('lowStock')}
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
                  {t('sku')}
                </th>
                <th scope="col" className={header}>
                  {t('name')}
                </th>
                <th scope="col" className={header}>
                  {t('brand')}
                </th>
                <th scope="col" className={header}>
                  {t('price')}
                </th>
                {canSeeCost ? (
                  <th scope="col" className={header}>
                    {t('cost')}
                  </th>
                ) : null}
                <th scope="col" className={header}>
                  {t('variants')}
                </th>
                <th scope="col" className={header}>
                  {t('stock')}
                </th>
                <th scope="col" className={header}>
                  {t('status')}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.id} className="border-b border-border">
                  <td className={cell}>{item.sku}</td>
                  <td className={cell}>
                    <a className="underline" href={`/admin/products/${item.id}`}>
                      {item.nameUk}
                    </a>
                  </td>
                  <td className={cell}>{item.brand}</td>
                  <td className={cell}>{formatMoney(money(item.basePrice), locale)}</td>
                  {canSeeCost ? (
                    <td className={cell}>
                      {'costPrice' in item && item.costPrice !== null
                        ? formatMoney(money(item.costPrice), locale)
                        : '—'}
                    </td>
                  ) : null}
                  <td className={cell}>{item.variantsCount}</td>
                  <td className={cell}>{item.stockTotal}</td>
                  <td className={cell}>{item.isActive ? t('stateActive') : t('stateInactive')}</td>
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
