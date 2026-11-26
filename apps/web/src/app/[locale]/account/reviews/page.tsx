import { listReviewableProducts } from '@store/core/reviews';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AccountFrame } from '@/components/account/account-frame';
import { ReviewForm } from '@/components/account/review-form';
import { resolveLocale } from '@/i18n/locale';
import { getDb } from '@/lib/db';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account/reviews'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return { title: t('section.reviews'), robots: { index: false, follow: false } };
}

/** The products of MY orders that can be reviewed (the purchase is checked again when a review is sent). */
export default async function AccountReviewsPage({ params }: Props) {
  return (
    <AccountFrame
      rawLocale={(await params).locale}
      path={paths.accountReviews}
      title={(t) => t('section.reviews')}
    >
      {async ({ locale, customer }) => {
        const lines = await listReviewableProducts(await getDb(), customer.customerId, locale);
        const t = await getTranslations('account');
        if (lines.length === 0) return <p>{t('noReviewable')}</p>;
        return (
          <ul className="flex max-w-xl flex-col gap-6">
            {lines.map((line) => (
              <li key={line.productId} className="rounded-sm border border-border p-3">
                <p className="font-medium">{line.name}</p>
                <p className="text-sm text-text-muted">{line.sizeLabel}</p>
                {line.reviewed ? (
                  <p className="mt-2 text-sm">{t('reviewDone')}</p>
                ) : (
                  <ReviewForm productId={line.productId} />
                )}
              </li>
            ))}
          </ul>
        );
      }}
    </AccountFrame>
  );
}
