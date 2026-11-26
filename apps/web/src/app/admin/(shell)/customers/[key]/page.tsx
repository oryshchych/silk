import { can } from '@store/core/auth-permissions';
import { getCustomer } from '@store/core/customers-admin-read';
import { formatMoney, money } from '@store/shared/money';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { CustomerForm } from '@/components/admin/customer-form';
import { formatWhen } from '@/lib/admin/format';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function AdminCustomerPage({ params }: { params: Promise<{ key: string }> }) {
  const session = await requirePermission('customers.view');
  const customer = await getCustomer(await getDb(), (await params).key);
  if (customer === null) notFound();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.customers' });
  const price = (kopiyky: number) => formatMoney(money(kopiyky), locale);
  const header = 'px-3 py-2 text-left font-medium';
  const cell = 'px-3 py-2 align-top';
  return (
    <>
      <a href="/admin/customers" className="inline-flex min-h-11 items-center underline">
        {t('back')}
      </a>
      <h1 className="text-2xl font-semibold">{customer.name}</h1>
      <p className="mt-1 text-text-muted">
        {customer.email} · {customer.phone} · {t(`segment.${customer.segment}`)}
      </p>
      <dl className="mt-4 grid max-w-md grid-cols-2 gap-1">
        <dt>{t('col.orders')}</dt>
        <dd>{customer.ordersCount}</dd>
        <dt>{t('col.ltv')}</dt>
        <dd>{price(customer.ltv)}</dd>
        <dt>{t('average')}</dt>
        <dd>{price(customer.averageOrder)}</dd>
        <dt>{t('first')}</dt>
        <dd>{formatWhen(customer.firstOrderAt, locale)}</dd>
        <dt>{t('col.last')}</dt>
        <dd>{formatWhen(customer.lastOrderAt, locale)}</dd>
      </dl>

      <h2 className="mt-6 text-lg font-semibold">{t('sizes')}</h2>
      {customer.sizes.length === 0 ? (
        <p>{t('noSizes')}</p>
      ) : (
        <>
          <p className="mt-1">
            {t('favourite')}:{' '}
            {customer.favouriteSizes.map((size) => `${size.system} ${size.label}`).join(', ')}
          </p>
          <ul className="mt-2 space-y-1">
            {customer.sizes.map((size) => (
              <li key={`${size.system}-${size.label}`}>
                {size.system} {size.label}: {size.units}
              </li>
            ))}
          </ul>
        </>
      )}

      {can(session.role, 'customers.manage') ? (
        <CustomerForm customerKey={customer.key} tags={customer.tags} note={customer.note} />
      ) : null}

      <h2 className="mt-6 text-lg font-semibold">{t('orders')}</h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">{t('orders')}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={header}>
                {t('orderNumber')}
              </th>
              <th scope="col" className={header}>
                {t('col.last')}
              </th>
              <th scope="col" className={header}>
                {t('orderStatus')}
              </th>
              <th scope="col" className={header}>
                {t('orderTotal')}
              </th>
            </tr>
          </thead>
          <tbody>
            {customer.orders.map((order) => (
              <tr key={order.id} className="border-b border-border">
                <td className={cell}>
                  {can(session.role, 'orders.view') ? (
                    <a
                      className="inline-flex min-h-11 items-center underline"
                      href={`/admin/orders/${order.id}`}
                    >
                      {order.orderNumber}
                    </a>
                  ) : (
                    order.orderNumber
                  )}
                </td>
                <td className={cell}>{formatWhen(order.createdAt, locale)}</td>
                <td className={cell}>{t(`status.${order.status}`)}</td>
                <td className={cell}>{price(order.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
