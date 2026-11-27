import { can } from '@store/core/auth-permissions';
import { listPromoCodes } from '@store/core/promo-admin';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { PromoTable } from '@/components/admin/promo-table';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { parsePromoFilters } from '@/lib/admin/promo-filters';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

const STATUSES = ['active', 'inactive', 'exhausted', 'ended', 'upcoming'] as const;
const TYPES = ['percent', 'fixed', 'free_shipping'] as const;
const SCOPES = ['all', 'category', 'product'] as const;
type SortKey = 'code' | 'uses' | 'revenue' | 'created' | 'ends';

/**
 * The promo-code list: filters, sorting by header and pages are all in the URL and run in SQL
 * (read-only transaction, 5 s timeout). `content` has no access; a manager reads without the
 * author column and without the buttons.
 */
export default async function PromoCodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission('promo.view');
  const canManage = can(session.role, 'promo.manage');
  const raw = await searchParams;
  const filters = parsePromoFilters(raw);
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.promo' });
  const page = await listPromoCodes(await getDb(), filters, canManage);

  const query = (patch: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      q: filters.q,
      status: filters.status,
      type: filters.type,
      scope: filters.scope,
      createdFrom: filters.createdFrom,
      createdTo: filters.createdTo,
      hasUses: filters.hasUses === true ? '1' : undefined,
      sort: filters.sort,
      dir: filters.dir,
      ...patch,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    const text = params.toString();
    return text === '' ? '' : `?${text}`;
  };
  const sortLink = (key: SortKey): string =>
    `/admin/marketing/promo-codes${query({
      sort: key,
      dir: filters.sort === key && filters.dir === 'asc' ? 'desc' : 'asc',
      page: undefined,
    })}`;
  const sortHref = {
    code: sortLink('code'),
    uses: sortLink('uses'),
    revenue: sortLink('revenue'),
    created: sortLink('created'),
    ends: sortLink('ends'),
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <form method="get" className="mt-3 flex flex-wrap items-end gap-3" aria-label={t('filters')}>
        <label>
          {t('search')}
          <input
            name="q"
            defaultValue={filters.q ?? ''}
            maxLength={100}
            className="ml-2 min-h-11 rounded-md border border-border px-3"
          />
        </label>
        <label>
          {t('status')}
          <select
            name="status"
            defaultValue={filters.status ?? ''}
            className="ml-2 min-h-11 rounded-md border border-border px-3"
          >
            <option value="">{t('any')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`statuses.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('type')}
          <select
            name="type"
            defaultValue={filters.type ?? ''}
            className="ml-2 min-h-11 rounded-md border border-border px-3"
          >
            <option value="">{t('any')}</option>
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`types.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('scope')}
          <select
            name="scope"
            defaultValue={filters.scope ?? ''}
            className="ml-2 min-h-11 rounded-md border border-border px-3"
          >
            <option value="">{t('any')}</option>
            {SCOPES.map((value) => (
              <option key={value} value={value}>
                {t(`scopes.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('createdFrom')}
          <input
            type="date"
            name="createdFrom"
            defaultValue={filters.createdFrom ?? ''}
            className="ml-2 min-h-11 rounded-md border border-border px-3"
          />
        </label>
        <label>
          {t('createdTo')}
          <input
            type="date"
            name="createdTo"
            defaultValue={filters.createdTo ?? ''}
            className="ml-2 min-h-11 rounded-md border border-border px-3"
          />
        </label>
        <label className="inline-flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            name="hasUses"
            value="1"
            defaultChecked={filters.hasUses === true}
            className="size-5"
          />
          {t('hasUses')}
        </label>
        <button type="submit" className="min-h-11 rounded-md border border-border px-4">
          {t('apply')}
        </button>
      </form>
      <p className="mt-3 flex gap-4">
        {canManage ? (
          <>
            <a
              href="/admin/marketing/promo-codes/new"
              className="inline-flex min-h-11 items-center underline"
            >
              {t('create')}
            </a>
            <a
              href={`/admin/export/promo-codes${query({})}`}
              className="inline-flex min-h-11 items-center underline"
            >
              {t('exportCsv')}
            </a>
          </>
        ) : null}
        <span className="inline-flex min-h-11 items-center text-text-muted">
          {t('total', { count: page.total })}
        </span>
      </p>
      {page.items.length === 0 ? <p className="mt-4">{t('empty')}</p> : null}
      <PromoTable rows={page.items} canManage={canManage} sortHref={sortHref} />
      <nav aria-label={t('pages')} className="mt-4 flex gap-4">
        {page.page > 1 ? (
          <a
            href={`/admin/marketing/promo-codes${query({ page: String(page.page - 1) })}`}
            className="inline-flex min-h-11 items-center underline"
          >
            {t('prev')}
          </a>
        ) : null}
        <span className="inline-flex min-h-11 items-center">
          {page.page} / {page.totalPages}
        </span>
        {page.page < page.totalPages ? (
          <a
            href={`/admin/marketing/promo-codes${query({ page: String(page.page + 1) })}`}
            className="inline-flex min-h-11 items-center underline"
          >
            {t('next')}
          </a>
        ) : null}
      </nav>
    </div>
  );
}
