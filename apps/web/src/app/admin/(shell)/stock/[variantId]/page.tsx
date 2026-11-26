import { listReservingOrders, listStockHistory } from '@store/core/admin-stock-read';
import { can } from '@store/core/auth-permissions';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function StockHistoryPage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  const session = await requireFullSession();
  const id = z.uuid().safeParse((await params).variantId);
  if (!id.success) notFound();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.stock' });
  const db = await getDb();
  const rows = await listStockHistory(db, id.data, 50);
  const reserving = await listReservingOrders(db, id.data);
  const canOpenOrders = can(session.role, 'orders.view');
  const header = 'px-3 py-2 text-left font-medium';
  const cell = 'px-3 py-2 align-top';
  return (
    <>
      <a href="/admin/stock" className="inline-flex min-h-11 items-center underline">
        {t('back')}
      </a>
      <h1 className="text-2xl font-semibold">{t('historyTitle')}</h1>
      <section aria-labelledby="reserved-by" className="mt-4">
        <h2 id="reserved-by" className="text-lg font-semibold">
          {t('reservedBy')}
        </h2>
        <p className="text-text-muted">{t('reservedHint')}</p>
        {reserving.length === 0 ? (
          <p className="mt-2">{t('noReservations')}</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {reserving.map((order) => (
              <li key={order.orderId}>
                {canOpenOrders ? (
                  <a
                    className="inline-flex min-h-11 items-center underline"
                    href={`/admin/orders/${order.orderId}`}
                  >
                    {order.orderNumber}
                  </a>
                ) : (
                  order.orderNumber
                )}{' '}
                · {t('reservedQty', { count: order.quantity })} · {order.status} · {order.at}
              </li>
            ))}
          </ul>
        )}
      </section>
      {rows.length === 0 ? (
        <p className="mt-4">{t('noHistory')}</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t('historyTitle')}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={header}>
                  {t('when')}
                </th>
                <th scope="col" className={header}>
                  {t('reason')}
                </th>
                <th scope="col" className={header}>
                  {t('change')}
                </th>
                <th scope="col" className={header}>
                  {t('before')}
                </th>
                <th scope="col" className={header}>
                  {t('after')}
                </th>
                <th scope="col" className={header}>
                  {t('note')}
                </th>
                <th scope="col" className={header}>
                  {t('by')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border">
                  <td className={cell}>{row.at}</td>
                  <td className={cell}>{row.reason}</td>
                  <td className={cell}>
                    {row.delta > 0 ? `+${String(row.delta)}` : String(row.delta)}
                  </td>
                  <td className={cell}>{row.before}</td>
                  <td className={cell}>{row.after}</td>
                  <td className={cell}>{row.note ?? ''}</td>
                  <td className={cell}>{row.by ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
