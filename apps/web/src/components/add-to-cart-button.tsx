'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, useTransition } from 'react';

import type { AnalyticsItem } from '@store/shared/analytics';

import { addToCartAction } from '@/actions/cart';
import { trackEvent } from '@/lib/analytics/browser';
import { CART_CHANGED_EVENT } from '@/lib/cart-events';
import { messageCode } from '@/lib/error-codes';

type Status = { kind: 'idle' } | { kind: 'added' } | { kind: 'error'; code: string };

/** Adds the chosen variant. The browser sends a variant id and a quantity; the server does the rest. */
export function AddToCartButton({
  variantId,
  cartHref,
  trackItem,
}: {
  variantId: string | null;
  cartHref: string;
  /** What analytics hears when the add succeeds (null: nothing). */
  trackItem: AnalyticsItem | null;
}) {
  const t = useTranslations('product');
  const te = useTranslations('errors.codes');
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  function add(): void {
    if (variantId === null) return;
    start(async () => {
      const result = await addToCartAction({ variantId, quantity: 1 });
      if (result.ok) {
        setStatus({ kind: 'added' });
        if (trackItem !== null) trackEvent({ name: 'add_to_cart', items: [trackItem] });
        window.dispatchEvent(new Event(CART_CHANGED_EVENT));
      } else {
        setStatus({ kind: 'error', code: result.code });
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={add}
        disabled={variantId === null || pending}
        className="min-h-11 rounded-full bg-accent px-6 text-accent-contrast disabled:opacity-50"
      >
        {pending ? t('adding') : t('addToCart')}
      </button>
      <div aria-live="polite" className="text-sm">
        {status.kind === 'added' ? (
          <p>
            {t('added')}{' '}
            <Link href={cartHref} className="underline">
              {t('viewCart')}
            </Link>
          </p>
        ) : null}
        {status.kind === 'error' ? <p role="alert">{te(messageCode(status.code))}</p> : null}
      </div>
    </div>
  );
}
