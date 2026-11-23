'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import { payOrderAction } from '@/actions/pay';
import { messageCode } from '@/lib/error-codes';

type Card = 'mono' | 'wayforpay';
const REFRESH_MS = 4_000;
const MAX_REFRESHES = 30;

/**
 * The payment block of the order page. The status shown comes from the server on every render;
 * while a card payment is pending the page re-reads it (no mutation, GET only) for about two
 * minutes. Pay buttons start a new attempt on THIS order, never a new order.
 */
export function OrderPayment({
  locale,
  state,
  cards,
}: {
  locale: 'uk' | 'en';
  state: 'paid' | 'pending' | 'failed' | 'expired' | 'refunded';
  cards: readonly Card[];
}) {
  const t = useTranslations('order');
  const tc = useTranslations('checkout');
  const te = useTranslations('errors.codes');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (state !== 'pending') return;
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      router.refresh();
      if (count >= MAX_REFRESHES) clearInterval(timer);
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [state, router]);

  const message = {
    paid: t('payPaid'),
    pending: t('payWaiting'),
    failed: t('payFailed'),
    expired: t('payExpired'),
    refunded: t('payRefunded'),
  }[state];
  const canPay = state !== 'paid' && state !== 'refunded' && cards.length > 0;

  function pay(provider: Card): void {
    if (pending) return;
    setFailure(null);
    start(async () => {
      // A success redirects to the provider; whatever comes back is a refusal to show.
      const result = await payOrderAction({ locale, provider });
      setFailure(te(messageCode(result.code)));
    });
  }

  return (
    <section aria-labelledby="order-pay-title" className="flex flex-col gap-3">
      <h2 id="order-pay-title" className="sr-only">
        {t('payGroup')}
      </h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {canPay ? (
        <div className="flex flex-wrap gap-3">
          {cards.map((card) => (
            <button
              key={card}
              type="button"
              disabled={pending}
              onClick={() => {
                pay(card);
              }}
              className="min-h-11 rounded border px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
            >
              {t('payWith', { method: tc(`pay.${card}`) })}
            </button>
          ))}
        </div>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      )}
    </section>
  );
}
