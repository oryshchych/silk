import { can } from '@store/core/auth-permissions';
import { getAdminOrder } from '@store/core/orders-admin-read';
import { trackingUrl } from '@store/payments/shipping';
import { formatMoney, money } from '@store/shared/money';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { OrderActions } from '@/components/admin/order-actions';
import { OrderItemsEditor } from '@/components/admin/order-items-editor';
import { OrderWaybill } from '@/components/admin/order-waybill';
import { RefundOperationActions } from '@/components/admin/refund-operation-actions';
import { OrderRefundForm } from '@/components/admin/order-refund-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { formatWhen } from '@/lib/admin/format';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('orders.view');
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.orders' });
  const canSeeCost = can(session.role, 'catalog.cost.view');
  const order = await getAdminOrder(await getDb(), id.data, canSeeCost);
  if (order === null) notFound();
  const when = (iso: string) => formatWhen(iso, locale);
  const price = (kopiyky: number) => formatMoney(money(kopiyky), locale);
  const header = 'px-3 py-2 text-left font-medium';
  const cell = 'px-3 py-2 align-top';
  const canManage = can(session.role, 'orders.manage');
  const steps = canManage ? order.actions.filter((action) => action !== 'cancel') : [];
  return (
    <>
      <a href="/admin/orders" className="inline-flex min-h-11 items-center underline">
        {t('back')}
      </a>
      <h1 className="text-2xl font-semibold">{order.orderNumber}</h1>
      <p className="mt-1 text-text-muted">
        {t(`status.${order.status}`)} · {t(`pay.${order.paymentStatus}`)} ·{' '}
        {order.paymentProvider === null ? '—' : t(`provider.${order.paymentProvider}`)}
      </p>
      <dl className="mt-4 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <dt className="font-medium">{t('customer')}</dt>
        <dd>
          {order.customerName}, {order.customerPhone}, {order.customerEmail}
        </dd>
        <dt className="font-medium">{t('delivery')}</dt>
        <dd>
          {t(`method.${order.deliveryMethod}`)}
          {[order.deliverySettlementName, order.deliveryWarehouseName, order.deliveryAddress]
            .filter((part) => part !== null)
            .map((part) => `, ${part}`)
            .join('')}
        </dd>
        <dt className="font-medium">{t('col.ttn')}</dt>
        <dd>{order.ttn ?? '—'}</dd>
        <dt className="font-medium">{t('created')}</dt>
        <dd>{when(order.createdAt)}</dd>
        {order.comment === null ? null : (
          <>
            <dt className="font-medium">{t('buyerComment')}</dt>
            <dd>{order.comment}</dd>
          </>
        )}
      </dl>

      <h2 className="mt-6 text-lg font-semibold">{t('items')}</h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">{t('items')}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={header}>
                {t('item.name')}
              </th>
              <th scope="col" className={header}>
                {t('item.variant')}
              </th>
              <th scope="col" className={header}>
                {t('item.price')}
              </th>
              <th scope="col" className={header}>
                {t('item.qty')}
              </th>
              {canSeeCost ? (
                <th scope="col" className={header}>
                  {t('item.cost')}
                </th>
              ) : null}
              <th scope="col" className={header}>
                {t('item.total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} className="border-b border-border">
                <td className={cell}>{item.name}</td>
                <td className={cell}>{`${item.sku} · ${item.colorName} / ${item.sizeLabel}`}</td>
                <td className={cell}>{price(item.unitPrice)}</td>
                <td className={cell}>{item.quantity}</td>
                {canSeeCost ? (
                  <td className={cell}>
                    {'unitCostSnapshot' in item && item.unitCostSnapshot !== null
                      ? price(item.unitCostSnapshot)
                      : '—'}
                  </td>
                ) : null}
                <td className={cell}>{price(item.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="mt-3 grid max-w-md grid-cols-2 gap-1">
        <dt>{t('sum.subtotal')}</dt>
        <dd>{price(order.subtotal)}</dd>
        <dt>{t('sum.discount')}</dt>
        <dd>{price(order.discountTotal)}</dd>
        <dt>{t('sum.shipping')}</dt>
        <dd>{price(order.shippingTotal)}</dd>
        <dt>{t('sum.adjustment')}</dt>
        <dd>{price(order.adjustmentTotal)}</dd>
        <dt className="font-medium">{t('sum.total')}</dt>
        <dd className="font-medium">{price(order.total)}</dd>
        <dt>{t('sum.captured')}</dt>
        <dd>{price(order.capturedTotal)}</dd>
        <dt>{t('sum.refunded')}</dt>
        <dd>{price(order.refundedTotal)}</dd>
      </dl>

      <OrderActions
        orderId={order.id}
        steps={steps}
        canCancel={can(session.role, 'orders.cancel') && order.actions.includes('cancel')}
        canNote={canManage}
        hasReceivedMoney={order.capturedTotal > order.refundedTotal}
        canConfirmTransfer={
          can(session.role, 'orders.confirm_payment') &&
          order.paymentProvider === 'bank_transfer' &&
          order.paymentStatus !== 'paid' &&
          (order.status === 'pending' || order.status === 'cancelled')
        }
      />

      {can(session.role, 'orders.waybill') &&
      (order.deliveryMethod === 'np_warehouse' || order.deliveryMethod === 'np_courier') ? (
        <OrderWaybill
          orderId={order.id}
          ttn={order.ttn}
          trackingUrl={order.ttn === null ? null : trackingUrl(order.ttn)}
          shipmentState={order.shipment?.state ?? null}
          shipmentError={order.shipment?.error ?? null}
          canCreate={order.status === 'confirmed' || order.status === 'processing'}
        />
      ) : null}
      {can(session.role, 'orders.edit') && order.actions.includes('cancel') ? (
        <OrderItemsEditor
          orderId={order.id}
          items={order.items.map((item) => ({
            id: item.id,
            label: `${item.name} (${item.sku} · ${item.colorName} / ${item.sizeLabel})`,
            quantity: item.quantity,
          }))}
        />
      ) : null}
      {can(session.role, 'orders.refund') && order.capturedTotal > order.refundedTotal ? (
        <OrderRefundForm
          orderId={order.id}
          attempts={order.attempts
            .filter((attempt) => attempt.capturedAmount > 0)
            .map((attempt) => ({
              id: attempt.id,
              label: `#${String(attempt.attemptNumber)} ${attempt.provider} ${price(attempt.capturedAmount)}`,
            }))}
        />
      ) : null}

      <h2 className="mt-6 text-lg font-semibold">{t('payments')}</h2>
      {order.paymentEvents.length === 0 ? (
        <p>{t('noEvents')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {order.paymentEvents.map((event) => (
            <li key={event.id}>
              {when(event.at)} · {event.provider} · {event.eventType ?? '—'} ·{' '}
              {event.mappedStatus === null ? '—' : t(`pay.${event.mappedStatus}`)}
              {event.amount === null ? '' : ` · ${price(event.amount)}`}
              {event.applied ? '' : ` · ${t('notApplied')}`}
            </li>
          ))}
        </ul>
      )}

      {order.refunds.length === 0 ? null : (
        <>
          <h2 className="mt-6 text-lg font-semibold">{t('refunds')}</h2>
          <ul className="mt-2 space-y-1">
            {order.refunds.map((refund) => (
              <li key={refund.id}>
                {when(refund.at)} · {price(refund.amount)} · {t(`opState.${refund.state}`)}
                {refund.reason === null ? '' : ` · ${refund.reason}`}
                {can(session.role, 'orders.refund') &&
                (refund.state === 'pending' ||
                  refund.state === 'in_flight' ||
                  refund.state === 'unknown') ? (
                  <RefundOperationActions operationId={refund.id} state={refund.state} />
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="mt-6 text-lg font-semibold">{t('history')}</h2>
      <ul className="mt-2 space-y-1">
        {order.history.map((entry) => (
          <li key={entry.id}>
            {when(entry.at)} ·{' '}
            {entry.field === 'note'
              ? `${t('note')}: ${entry.comment ?? ''}`
              : `${entry.field}: ${entry.from ?? '—'} → ${entry.to}${entry.comment === null ? '' : ` (${entry.comment})`}`}
            {' · '}
            {entry.byEmail ?? entry.source}
          </li>
        ))}
      </ul>
    </>
  );
}
