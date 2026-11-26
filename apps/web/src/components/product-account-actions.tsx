'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { addToWishlistAction, subscribeStockAlertAction } from '@/actions/account-data';
import type { SelectableVariant } from '@/lib/variant-selection';

type Outcome = 'saved' | 'alerted' | 'error' | 'available' | null;

/**
 * "Save to the wishlist" and "tell me when this size is back". Both are actions of a signed-in
 * customer: without a session the visitor goes to the sign-in page. Nothing here is rendered from
 * the visitor's data, so the cached product page stays the same for everyone.
 */
export function ProductAccountActions({
  productId,
  variants,
  colorSlug,
  loginHref,
}: {
  productId: string;
  variants: readonly SelectableVariant[];
  colorSlug: string;
  loginHref: string;
}) {
  const t = useTranslations('product');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<Outcome>(null);
  const soldOut = variants.filter(
    (variant) => variant.colorSlug === colorSlug && !variant.available,
  );

  function run(work: () => Promise<{ ok: boolean; code?: string }>, done: Outcome): void {
    start(async () => {
      const result = await work();
      if (result.ok) setOutcome(done);
      else if (result.code === 'unauthorized') router.push(loginHref);
      else setOutcome(result.code === 'invalid' ? 'available' : 'error');
    });
  }

  const button =
    'min-h-11 rounded-full border border-border px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          run(async () => await addToWishlistAction({ productId }), 'saved');
        }}
        className={`${button} w-fit`}
      >
        {t('wishlistAdd')}
      </button>
      {soldOut.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text-muted">{t('alertIntro')}</p>
          <ul className="flex flex-wrap gap-2">
            {soldOut.map((variant) => (
              <li key={variant.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    run(
                      async () => await subscribeStockAlertAction({ variantId: variant.id }),
                      'alerted',
                    );
                  }}
                  className={button}
                >
                  {t('alertSize', { size: variant.sizeLabel })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div aria-live="polite" className="min-h-5 text-sm">
        {outcome === null ? null : <p>{t(`account.${outcome}`)}</p>}
      </div>
    </div>
  );
}
