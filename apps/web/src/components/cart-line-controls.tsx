'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import type { AnalyticsItem } from '@store/shared/analytics';

import { setCartLineAction } from '@/actions/cart';
import { trackEvent } from '@/lib/analytics/browser';
import { CART_CHANGED_EVENT } from '@/lib/cart-events';
import { messageCode } from '@/lib/error-codes';

const BUTTON =
  'inline-flex size-8 items-center justify-center rounded-full border border-border focus-visible:outline-2 disabled:opacity-50';

/** Quantity buttons and remove for one cart line; the page re-renders from the server afterwards. */
export function CartLineControls({
  variantId,
  name,
  quantity,
  item,
}: {
  variantId: string;
  name: string;
  quantity: number;
  /** The line as analytics knows it (its quantity is the current one). */
  item: AnalyticsItem;
}) {
  const t = useTranslations('cart');
  const te = useTranslations('errors.codes');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function set(next: number): void {
    start(async () => {
      const result = await setCartLineAction({ variantId, quantity: next });
      if (result.ok) {
        setError(null);
        if (next < quantity) {
          trackEvent({ name: 'remove_from_cart', items: [{ ...item, quantity: quantity - next }] });
        } else if (next > quantity) {
          trackEvent({ name: 'add_to_cart', items: [{ ...item, quantity: next - quantity }] });
        }
        window.dispatchEvent(new Event(CART_CHANGED_EVENT));
        router.refresh();
      } else {
        setError(result.code);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={pending || quantity <= 1}
          aria-label={t('decrease', { name })}
          onClick={() => {
            set(quantity - 1);
          }}
        >
          <span aria-hidden="true">−</span>
        </button>
        <span aria-live="polite" className="min-w-6 text-center">
          {quantity}
        </span>
        <button
          type="button"
          className={BUTTON}
          disabled={pending || quantity >= 99}
          aria-label={t('increase', { name })}
          onClick={() => {
            set(quantity + 1);
          }}
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          type="button"
          className="min-h-8 px-2 text-sm underline disabled:opacity-50"
          disabled={pending}
          aria-label={t('remove', { name })}
          onClick={() => {
            set(0);
          }}
        >
          {t('removeShort')}
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {te(messageCode(error))}
        </p>
      )}
    </div>
  );
}
