import { useTranslations } from 'next-intl';

import type { QuoteState } from './use-quote';

import { messageCode } from '@/lib/error-codes';

/** Sticky summary: every figure comes from the server quote, nothing is computed in the browser. */
export function OrderSummary({ quote }: { quote: QuoteState }) {
  const t = useTranslations('checkout');
  const te = useTranslations('errors.codes');
  return (
    <aside
      aria-labelledby="summary-title"
      className="h-fit rounded-sm border border-border p-4 lg:sticky lg:top-4"
    >
      <h2 id="summary-title" className="text-lg font-medium">
        {t('summaryTitle')}
      </h2>
      <div aria-live="polite">
        {quote.status === 'loading' ? <p className="mt-3 text-sm">{t('pricing')}</p> : null}
        {quote.status === 'error' ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {te(messageCode(quote.code))}
          </p>
        ) : null}
        {quote.status === 'ready' ? (
          <dl className="mt-3 flex flex-col gap-1 text-sm">
            <div className="flex justify-between">
              <dt>{t('subtotal')}</dt>
              <dd>{quote.summary.subtotal}</dd>
            </div>
            {quote.summary.hasDiscount ? (
              <div className="flex justify-between">
                <dt>{t('discount')}</dt>
                <dd>−{quote.summary.discount}</dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt>{t('shipping')}</dt>
              <dd>{quote.summary.shipping}</dd>
            </div>
            <div className="mt-2 flex justify-between border-t border-border pt-2 text-base font-medium">
              <dt>{t('total')}</dt>
              <dd>{quote.summary.total}</dd>
            </div>
            {quote.summary.freeShippingRemaining === null ? null : (
              <p className="mt-2 text-xs text-text-muted">
                {t('freeLeft', { amount: quote.summary.freeShippingRemaining })}
              </p>
            )}
          </dl>
        ) : null}
      </div>
    </aside>
  );
}
