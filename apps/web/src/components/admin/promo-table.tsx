'use client';

import type { AdminPromoRowDto, AdminPromoRowWithAuthorDto } from '@store/shared/dto/admin-promo';
import { formatMoney, money } from '@store/shared/money';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { bulkPromoCodesAction } from '../../actions/admin-promo';
import { formatWhen } from '../../lib/admin/format';

import { buttonClass } from './auth-card';
import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

type Row = AdminPromoRowDto | AdminPromoRowWithAuthorDto;

const OP_DEACTIVATE = 'deactivate';
const OP_EXTEND = 'extend';

function valueText(row: Row, locale: 'uk' | 'en', freeShipping: string): string {
  if (row.type === 'percent') return `${String(row.value)}%`;
  if (row.type === 'fixed') return formatMoney(money(row.value), locale);
  return freeShipping;
}

/**
 * The list with a checkbox per row and the bulk bar (only for a role that manages codes; the action
 * checks the permission again). A sortable header is a plain link: the sort lives in the URL.
 */
export function PromoTable({
  rows,
  canManage,
  sortHref,
}: {
  rows: readonly Row[];
  canManage: boolean;
  /** Link for each sortable column, already carrying the current filters and direction. */
  sortHref: Record<'code' | 'uses' | 'revenue' | 'created' | 'ends', string>;
}) {
  const t = useTranslations('admin.promo');
  const locale = useLocale() === 'en' ? 'en' : 'uk';
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const header = (key: keyof typeof sortHref, label: string) => (
    <th scope="col" className="p-2 text-left">
      <a href={sortHref[key]} className="inline-flex min-h-11 items-center underline">
        {label}
      </a>
    </th>
  );
  return (
    <div>
      {canManage ? (
        <form
          className="mb-3 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const ids = [...selected];
            if (ids.length === 0) return;
            const submitter =
              event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
            const op = submitter instanceof HTMLButtonElement ? submitter.value : '';
            const endsAt = textOf(readForm(event.currentTarget), 'bulkEndsAt');
            run(
              async () =>
                op === OP_EXTEND
                  ? await bulkPromoCodesAction({ op: 'extend', ids, endsAt })
                  : await bulkPromoCodesAction({ op: 'deactivate', ids }),
              t('bulkDone'),
              () => {
                setSelected(new Set());
                router.refresh();
              },
            );
          }}
        >
          <button
            type="submit"
            value={OP_DEACTIVATE}
            disabled={pending || selected.size === 0}
            className={buttonClass}
          >
            {t('bulkDeactivate')}
          </button>
          <label>
            {t('bulkEndsAt')}
            <input
              type="datetime-local"
              name="bulkEndsAt"
              className="ml-2 min-h-11 rounded-md border border-border px-3"
            />
          </label>
          <button
            type="submit"
            value={OP_EXTEND}
            disabled={pending || selected.size === 0}
            className={buttonClass}
          >
            {t('bulkExtend')}
          </button>
          <StatusLine message={message} />
        </form>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[60rem] border-collapse">
          <caption className="sr-only">{t('title')}</caption>
          <thead>
            <tr>
              {canManage ? (
                <th scope="col" className="p-2">
                  <span className="sr-only">{t('select')}</span>
                </th>
              ) : null}
              {header('code', t('code'))}
              <th scope="col" className="p-2 text-left">
                {t('discount')}
              </th>
              {header('uses', t('uses'))}
              {header('revenue', t('captured'))}
              {header('ends', t('period'))}
              <th scope="col" className="p-2 text-left">
                {t('status')}
              </th>
              {header('created', t('created'))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                {canManage ? (
                  <td className="p-2">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={selected.has(row.id)}
                      onChange={() => {
                        toggle(row.id);
                      }}
                      aria-label={`${t('select')} ${row.code}`}
                    />
                  </td>
                ) : null}
                <td className="p-2">
                  <a
                    href={`/admin/marketing/promo-codes/${row.id}`}
                    className="inline-flex min-h-11 items-center underline"
                  >
                    {row.code}
                  </a>
                  {row.description === null ? null : (
                    <div className="text-sm text-text-muted">{row.description}</div>
                  )}
                </td>
                <td className="p-2">{valueText(row, locale, t('types.free_shipping'))}</td>
                <td className="p-2">
                  <progress
                    value={row.consumedCount}
                    max={row.maxUses ?? Math.max(row.consumedCount, 1)}
                    aria-label={t('uses')}
                    className="mr-2 align-middle"
                  />
                  {row.consumedCount}
                  {row.maxUses === null ? '' : ` / ${String(row.maxUses)}`}
                </td>
                <td className="p-2">{formatMoney(row.capturedTotal, locale)}</td>
                <td className="p-2">
                  {row.startsAt === null ? '—' : formatWhen(row.startsAt, locale)}
                  {' → '}
                  {row.endsAt === null ? '—' : formatWhen(row.endsAt, locale)}
                </td>
                <td className="p-2">{t(`statuses.${row.status}`)}</td>
                <td className="p-2">
                  {formatWhen(row.createdAt, locale)}
                  {'createdBy' in row && row.createdBy !== null ? (
                    <div className="text-sm text-text-muted">{row.createdBy}</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
