import { listMyStockAlerts } from '@store/core/account-alerts';
import { listMyWishlist } from '@store/core/account-wishlist';
import { formatMoney } from '@store/shared/money';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { AccountFrame } from '@/components/account/account-frame';
import { WishlistLists } from '@/components/account/wishlist-lists';
import { resolveLocale } from '@/i18n/locale';
import { getDb } from '@/lib/db';
import { href, paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account/wishlist'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return { title: t('section.wishlist'), robots: { index: false, follow: false } };
}

export default async function AccountWishlistPage({ params }: Props) {
  return (
    <AccountFrame
      rawLocale={(await params).locale}
      path={paths.accountWishlist}
      title={(t) => t('section.wishlist')}
    >
      {async ({ locale, customer }) => {
        const db = await getDb();
        const [items, alerts] = await Promise.all([
          listMyWishlist(db, customer.customerId, locale),
          listMyStockAlerts(db, customer.email, locale),
        ]);
        const t = await getTranslations('account');
        return (
          <div className="flex flex-col gap-8">
            <section aria-labelledby="wishlist-h" className="flex flex-col gap-3">
              <h2 id="wishlist-h" className="font-display text-xl">
                {t('section.wishlist')}
              </h2>
              {items.length === 0 ? <p>{t('noWishlist')}</p> : null}
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li
                    key={item.productId}
                    className="flex items-center justify-between gap-3 rounded-sm border border-border p-3"
                  >
                    <div>
                      <Link
                        href={href(locale, paths.product(item.slug))}
                        className="font-medium underline"
                      >
                        {item.name}
                      </Link>
                      <p className="text-sm text-text-muted">
                        {formatMoney(item.price, locale)} ·{' '}
                        {item.available ? t('inStock') : t('soldOut')}
                      </p>
                    </div>
                    <WishlistLists kind="wishlist" id={item.productId} />
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="alerts-h" className="flex flex-col gap-3">
              <h2 id="alerts-h" className="font-display text-xl">
                {t('alerts')}
              </h2>
              {alerts.length === 0 ? <p>{t('noAlerts')}</p> : null}
              <ul className="flex flex-col gap-2">
                {alerts.map((alert) => (
                  <li
                    key={alert.id}
                    className="flex items-center justify-between gap-3 rounded-sm border border-border p-3"
                  >
                    <div>
                      <Link
                        href={href(locale, paths.product(alert.productSlug))}
                        className="font-medium underline"
                      >
                        {alert.productName}
                      </Link>
                      <p className="text-sm text-text-muted">
                        {alert.sizeLabel} · {alert.colorName} ·{' '}
                        {alert.waiting ? t('alertWaiting') : t('alertSent')}
                      </p>
                    </div>
                    <WishlistLists kind="alert" id={alert.id} />
                  </li>
                ))}
              </ul>
            </section>
          </div>
        );
      }}
    </AccountFrame>
  );
}
