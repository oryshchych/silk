import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getCartView } from '@store/core/cart-view';
import { loadShippingSettings } from '@store/core/shipping';

import { CheckoutForm } from '@/components/checkout/checkout-form';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { readCartToken } from '@/lib/cart-cookie';
import { getDb } from '@/lib/db';
import { href, paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/checkout'>;

const ONLINE_METHODS = ['cod', 'bank_transfer', 'mono', 'wayforpay'] as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'checkout' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return { title: `${t('title')} | ${tm('siteName')}`, robots: { index: false, follow: false } };
}

export default async function CheckoutPage({ params }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const t = await getTranslations('checkout');
  const db = await getDb();
  const token = await readCartToken();
  const view = token === null ? null : await getCartView(db, token, locale);
  const settings = await loadShippingSettings(db);
  const payments = ONLINE_METHODS.filter((method) => settings.paymentProviders[method]);

  return (
    <SiteShell locale={locale} path={paths.checkout} degrade>
      <h1 className="font-display text-3xl">{t('title')}</h1>
      {view === null || view.lines.length === 0 ? (
        <div className="mt-6">
          <p>{t('emptyCart')}</p>
          <Link href={href(locale, paths.home)} className="mt-3 inline-block underline">
            {t('backToShop')}
          </Link>
        </div>
      ) : (
        <div className="mt-6">
          {view.hasProblems ? (
            <p role="status" className="mb-4 text-sm text-danger">
              {t('cartHasProblems')}{' '}
              <Link href={href(locale, paths.cart)} className="underline">
                {t('fixCart')}
              </Link>
            </p>
          ) : null}
          <CheckoutForm locale={locale} payments={payments} />
        </div>
      )}
    </SiteShell>
  );
}
