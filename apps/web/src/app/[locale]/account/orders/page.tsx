import { listMyOrders } from '@store/core/account-orders';
import { claimGuestOrders } from '@store/core/customer-auth';
import { formatMoney } from '@store/shared/money';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { AccountFrame } from '@/components/account/account-frame';
import { resolveLocale } from '@/i18n/locale';
import { getDb } from '@/lib/db';
import { href, paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account/orders'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return { title: t('section.orders'), robots: { index: false, follow: false } };
}

export default async function AccountOrdersPage({ params }: Props) {
  return (
    <AccountFrame
      rawLocale={(await params).locale}
      path={paths.accountOrders}
      title={(t) => t('section.orders')}
    >
      {async ({ locale, customer }) => {
        const db = await getDb();
        // Orders placed as a guest with this VERIFIED address (also after the account existed) join the account.
        await db.transaction(async (tx) => {
          await claimGuestOrders(tx, { customerId: customer.customerId, email: customer.email });
        });
        const rows = await listMyOrders(db, customer.customerId);
        const t = await getTranslations('account');
        const to = await getTranslations('order');
        if (rows.length === 0) return <p>{t('noOrders')}</p>;
        return (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <li key={row.orderNumber} className="rounded-sm border border-border p-3">
                <Link
                  href={href(locale, paths.accountOrder(row.orderNumber))}
                  className="font-medium underline"
                >
                  {row.orderNumber}
                </Link>
                <p className="text-sm text-text-muted">
                  {row.createdAt.slice(0, 10)} · {to(`statusLabel.${row.status}`)} ·{' '}
                  {formatMoney(row.total, locale)}
                </p>
              </li>
            ))}
          </ul>
        );
      }}
    </AccountFrame>
  );
}
