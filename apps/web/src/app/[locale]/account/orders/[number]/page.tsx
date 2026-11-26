import { getMyOrder } from '@store/core/account-orders';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AccountFrame } from '@/components/account/account-frame';
import { ReorderButton } from '@/components/account/reorder-button';
import { OrderDetails } from '@/components/order-details';
import { resolveLocale } from '@/i18n/locale';
import { getDb } from '@/lib/db';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account/orders/[number]'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return { title: t('section.orders'), robots: { index: false, follow: false } };
}

/** An order that is not MINE is a 404, exactly like one that does not exist. */
export default async function AccountOrderPage({ params }: Props) {
  const { locale: rawLocale, number } = await params;
  return (
    <AccountFrame
      rawLocale={rawLocale}
      path={paths.accountOrder(number)}
      title={(t) => t('section.orders')}
    >
      {async ({ locale, customer }) => {
        const order = await getMyOrder(
          await getDb(),
          customer.customerId,
          decodeURIComponent(number),
        );
        if (order === null) notFound();
        return (
          <div className="flex flex-col gap-4">
            <OrderDetails order={order} locale={locale} />
            {order.ttn === null ? null : (
              <p>
                <a
                  href={`https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(order.ttn)}`}
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {order.ttn}
                </a>
              </p>
            )}
            <ReorderButton orderNumber={order.orderNumber} locale={locale} />
          </div>
        );
      }}
    </AccountFrame>
  );
}
