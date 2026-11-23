import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getOrderByAccessToken } from '@store/core/order-lookup';

import { OrderDetails } from '@/components/order-details';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { readOrderAccess } from '@/lib/cart-cookie';
import { getDb } from '@/lib/db';
import { href, paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/order/success'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'order' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: `${t('successTitle')} | ${tm('siteName')}`,
    robots: { index: false, follow: false },
  };
}

/**
 * Reads the order from the database on every request (never from a cache) using the access token
 * the browser got when it placed the order; the order number alone opens nothing.
 */
export default async function OrderSuccessPage({ params }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const t = await getTranslations('order');
  const access = await readOrderAccess();
  const order =
    access === null
      ? null
      : await getOrderByAccessToken(await getDb(), access.orderNumber, access.token);

  return (
    <SiteShell locale={locale} path={paths.orderSuccess} degrade>
      {order === null ? (
        <div>
          <h1 className="font-display text-3xl">{t('noOrderTitle')}</h1>
          <p className="mt-3">{t('noOrderText')}</p>
          <Link href={href(locale, paths.orderTrack)} className="mt-3 inline-block underline">
            {t('trackLink')}
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <h1 className="font-display text-3xl">{t('successTitle')}</h1>
          <p>{t('successText')}</p>
          {order.paymentProvider === 'cod' ? <p className="text-sm">{t('nextCod')}</p> : null}
          {order.paymentProvider === 'bank_transfer' ? (
            <p className="text-sm">{t('nextTransfer')}</p>
          ) : null}
          <OrderDetails order={order} locale={locale} />
          <Link href={href(locale, paths.orderTrack)} className="underline">
            {t('trackLink')}
          </Link>
        </div>
      )}
    </SiteShell>
  );
}
