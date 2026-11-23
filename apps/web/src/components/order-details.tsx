import { useTranslations } from 'next-intl';

import type { CustomerOrderDto, TrackedOrderDto } from '@store/shared/dto/order';
import { formatMoney } from '@store/shared/money';
import type { SiteLocale } from '@store/shared/seo';

const METHODS = ['np_warehouse', 'np_courier', 'ukrposhta', 'pickup'] as const;
const PAYMENTS = ['cod', 'bank_transfer', 'mono', 'wayforpay', 'gift_card'] as const;
const STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;

const pick = <T extends string>(list: readonly T[], value: string | null): T | null =>
  list.find((item) => item === value) ?? null;

/** Items, delivery, payment, totals and status of an order. Works for the full and the tracked view. */
export function OrderDetails({
  order,
  locale,
}: {
  order: CustomerOrderDto | TrackedOrderDto;
  locale: SiteLocale;
}) {
  const t = useTranslations('order');
  const tc = useTranslations('checkout');
  const method = pick(METHODS, order.deliveryMethod);
  const payment = pick(PAYMENTS, order.paymentProvider);
  const status = pick(STATUSES, order.status);
  const address = 'deliveryAddress' in order ? order.deliveryAddress : null;

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-text-muted">{t('number')}</dt>
        <dd className="font-medium">{order.orderNumber}</dd>
        <dt className="text-text-muted">{t('status')}</dt>
        <dd>{status === null ? order.status : t(`statusLabel.${status}`)}</dd>
        <dt className="text-text-muted">{t('delivery')}</dt>
        <dd>
          {method === null ? order.deliveryMethod : tc(`method.${method}`)}
          {order.deliveryCity === null ? '' : `, ${order.deliveryCity}`}
          {order.deliveryPoint === null ? '' : `, ${order.deliveryPoint}`}
          {address === null ? '' : `, ${address}`}
        </dd>
        <dt className="text-text-muted">{t('payment')}</dt>
        <dd>{payment === null ? '' : tc(`pay.${payment}`)}</dd>
      </dl>
      <table className="w-full text-sm">
        <caption className="sr-only">{t('items')}</caption>
        <thead>
          <tr className="text-left text-text-muted">
            <th scope="col" className="py-1 font-normal">
              {t('item')}
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              {t('qty')}
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              {t('amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.sku} className="border-t border-border">
              <td className="py-2">
                {item.name}, {item.colorName}, {item.sizeLabel}
              </td>
              <td className="py-2 text-right">{item.quantity}</td>
              <td className="py-2 text-right">{formatMoney(item.lineTotal, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="ml-auto flex w-full max-w-xs flex-col gap-1 text-sm">
        <div className="flex justify-between">
          <dt>{tc('subtotal')}</dt>
          <dd>{formatMoney(order.subtotal, locale)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{tc('discount')}</dt>
          <dd>−{formatMoney(order.discountTotal, locale)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{tc('shipping')}</dt>
          <dd>{formatMoney(order.shippingTotal, locale)}</dd>
        </div>
        <div className="flex justify-between border-t border-border pt-1 text-base font-medium">
          <dt>{tc('total')}</dt>
          <dd>{formatMoney(order.total, locale)}</dd>
        </div>
      </dl>
    </div>
  );
}
