import { listEligibleOrders, listMyReturns } from '@store/core/returns';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AccountFrame } from '@/components/account/account-frame';
import { ReturnForm } from '@/components/account/return-form';
import { resolveLocale } from '@/i18n/locale';
import { getDb } from '@/lib/db';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account/returns'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return { title: t('section.returns'), robots: { index: false, follow: false } };
}

/** My requests, and the delivered orders still inside the window. The policy text is a placeholder (Q71). */
export default async function AccountReturnsPage({ params }: Props) {
  return (
    <AccountFrame
      rawLocale={(await params).locale}
      path={paths.accountReturns}
      title={(t) => t('section.returns')}
    >
      {async ({ customer }) => {
        const db = await getDb();
        const [mine, eligible] = await Promise.all([
          listMyReturns(db, customer.customerId),
          listEligibleOrders(db, customer.customerId),
        ]);
        const t = await getTranslations('account');
        const to = await getTranslations('order');
        return (
          <div className="flex max-w-xl flex-col gap-8">
            <p className="text-sm text-text-muted">{t('returnsPolicy')}</p>
            <section aria-labelledby="mine-h" className="flex flex-col gap-3">
              <h2 id="mine-h" className="font-display text-xl">
                {t('myReturns')}
              </h2>
              {mine.length === 0 ? <p>{t('noReturns')}</p> : null}
              <ul className="flex flex-col gap-2">
                {mine.map((request) => (
                  <li
                    key={request.requestNumber}
                    className="rounded-sm border border-border p-3 text-sm"
                  >
                    <p className="font-medium">
                      {request.requestNumber} · {request.orderNumber}
                    </p>
                    <p>{t(`returnStatus.${request.status}`)}</p>
                    <p className="text-text-muted">
                      {request.items
                        .map(
                          (item) => `${item.name} (${item.sizeLabel}) × ${String(item.quantity)}`,
                        )
                        .join(', ')}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="new-h" className="flex flex-col gap-4">
              <h2 id="new-h" className="font-display text-xl">
                {t('newReturn')}
              </h2>
              {eligible.length === 0 ? <p>{t('noEligible')}</p> : null}
              {eligible.map((order) => (
                <div key={order.orderNumber} className="rounded-sm border border-border p-3">
                  <p className="font-medium">
                    {to('number')}: {order.orderNumber}
                  </p>
                  <p className="text-sm text-text-muted">
                    {t('returnDeadline', { date: order.deadline.slice(0, 10) })}
                  </p>
                  <ReturnForm order={order} />
                </div>
              ))}
            </section>
          </div>
        );
      }}
    </AccountFrame>
  );
}
