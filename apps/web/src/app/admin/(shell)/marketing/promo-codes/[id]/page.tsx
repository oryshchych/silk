import { can } from '@store/core/auth-permissions';
import { getPromoCode, listPromoScopeCategories, readPromoStats } from '@store/core/promo-admin';
import { formatMoney } from '@store/shared/money';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { PromoForm } from '@/components/admin/promo-form';
import { formatWhen } from '@/lib/admin/format';
import { toKyivLocalInput } from '@/lib/admin/kyiv-time';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

/** One code: its statistics (counted from the consumed redemptions) and, for `promo.manage`, the edit form. */
export default async function PromoCodePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('promo.view');
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const canManage = can(session.role, 'promo.manage');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.promo' });
  const db = await getDb();
  const [row, stats] = await Promise.all([
    getPromoCode(db, id.data, canManage),
    readPromoStats(db, id.data),
  ]);
  if (row === null || stats === null) notFound();
  const cats = canManage ? await listPromoScopeCategories(db) : [];
  const money = (value: Parameters<typeof formatMoney>[0] | null) =>
    value === null ? '—' : formatMoney(value, locale);
  return (
    <div>
      <h1 className="text-2xl font-semibold">{row.code}</h1>
      <section aria-labelledby="stats" className="mt-4">
        <h2 id="stats" className="text-lg font-semibold">
          {t('stats')}
        </h2>
        <dl className="mt-2 grid max-w-xl grid-cols-2 gap-2">
          <dt>{t('uses')}</dt>
          <dd>{stats.consumedCount}</dd>
          <dt>{t('released')}</dt>
          <dd>{stats.releasedCount}</dd>
          <dt>{t('discountTotal')}</dt>
          <dd>{money(stats.discountTotal)}</dd>
          <dt>{t('captured')}</dt>
          <dd>{money(stats.netTotal)}</dd>
          <dt>{t('averageWith')}</dt>
          <dd>{money(stats.averageOrderWithCode)}</dd>
          <dt>{t('averageWithout')}</dt>
          <dd>{money(stats.averageOrderWithout)}</dd>
          <dt>{t('newCustomers')}</dt>
          <dd>{stats.newCustomers}</dd>
        </dl>
        {stats.byDay.length > 0 ? (
          <table className="mt-3">
            <caption className="text-left font-semibold">{t('usesByDay')}</caption>
            <tbody>
              {stats.byDay.map((day) => (
                <tr key={day.day}>
                  <th scope="row" className="pr-4 text-left">
                    {day.day}
                  </th>
                  <td>{day.uses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {stats.orders.length > 0 ? (
          <table className="mt-3">
            <caption className="text-left font-semibold">{t('orders')}</caption>
            <tbody>
              {stats.orders.map((order) => (
                <tr key={order.id}>
                  <th scope="row" className="pr-4 text-left">
                    <a href={`/admin/orders/${order.id}`} className="underline">
                      {order.orderNumber}
                    </a>
                  </th>
                  <td className="pr-4">{formatWhen(order.createdAt, locale)}</td>
                  <td className="pr-4">−{money(order.discountAmount)}</td>
                  <td>{money(order.netTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
      {canManage ? (
        <section className="mt-6" aria-labelledby="edit">
          <h2 id="edit" className="text-lg font-semibold">
            {t('editTitle')}
          </h2>
          <div className="mt-3">
            <PromoForm
              existing={{
                row,
                startsAtLocal: toKyivLocalInput(row.startsAt),
                endsAtLocal: toKyivLocalInput(row.endsAt),
              }}
              categories={cats.map((c) => ({
                id: c.id,
                name: locale === 'en' ? c.nameEn : c.nameUk,
              }))}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
