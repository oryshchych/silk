import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getCartView } from '@store/core/cart-view';
import { formatMoney } from '@store/shared/money';

import { CartLineControls } from '@/components/cart-line-controls';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { readCartToken } from '@/lib/cart-cookie';
import { getDb } from '@/lib/db';
import { href, paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/cart'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'cart' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return { title: `${t('title')} | ${tm('siteName')}`, robots: { index: false, follow: false } };
}

export default async function CartPage({ params }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const t = await getTranslations('cart');
  const token = await readCartToken();
  const view = token === null ? null : await getCartView(await getDb(), token, locale);
  const empty = view === null || view.lines.length === 0;

  return (
    <SiteShell locale={locale} path={paths.cart} degrade>
      <h1 className="font-display text-3xl">{t('title')}</h1>
      {empty ? (
        <div className="mt-6">
          <p>{t('empty')}</p>
          <Link href={href(locale, paths.home)} className="mt-3 inline-block underline">
            {t('continueShopping')}
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid gap-8 md:grid-cols-[1fr_20rem]">
          <ul className="flex flex-col divide-y divide-border">
            {view.lines.map((line) => (
              <li key={line.variantId} className="flex gap-4 py-4">
                <div className="size-24 shrink-0 overflow-hidden rounded-sm bg-surface-raised">
                  {line.image === null ? null : (
                    <Image
                      src={line.image.url}
                      alt={line.image.alt}
                      width={line.image.width ?? 200}
                      height={line.image.height ?? 250}
                      unoptimized
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Link
                    href={href(locale, paths.product(line.productSlug))}
                    className="font-medium hover:underline"
                  >
                    {line.name}
                  </Link>
                  <p className="text-sm text-text-muted">
                    {line.colorName}, {line.sizeLabel}
                  </p>
                  <p className="text-sm">{formatMoney(line.unitPrice, locale)}</p>
                  {line.sellable ? null : (
                    <p role="status" className="text-sm text-danger">
                      {t('gone')}
                    </p>
                  )}
                  {line.sellable && line.quantity > line.available ? (
                    <p role="status" className="text-sm text-danger">
                      {t('onlyLeft', { count: line.available })}
                    </p>
                  ) : null}
                  <CartLineControls
                    variantId={line.variantId}
                    name={line.name}
                    quantity={line.quantity}
                  />
                </div>
                <p className="font-medium">{formatMoney(line.lineTotal, locale)}</p>
              </li>
            ))}
          </ul>
          <aside className="h-fit rounded-sm border border-border p-4 md:sticky md:top-4">
            <p className="flex justify-between text-lg">
              <span>{t('subtotal')}</span>
              <span>{formatMoney(view.subtotal, locale)}</span>
            </p>
            <p className="mt-1 text-sm text-text-muted">{t('shippingNote')}</p>
            <Link
              href={href(locale, paths.checkout)}
              className="mt-4 flex min-h-11 items-center justify-center rounded-full bg-accent px-6 text-accent-contrast"
            >
              {t('checkout')}
            </Link>
          </aside>
        </div>
      )}
    </SiteShell>
  );
}
