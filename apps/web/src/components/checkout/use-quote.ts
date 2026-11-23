'use client';

import { useEffect, useRef, useState } from 'react';

import { quoteAction, type QuoteSummary } from '@/actions/checkout';

type Delivery = 'np_warehouse' | 'np_courier' | 'ukrposhta' | 'pickup';

export type QuoteState =
  | { status: 'loading' }
  | { status: 'ready'; summary: QuoteSummary }
  | { status: 'error'; code: string };

/**
 * Prices the cart on the server each time the delivery method or the applied promo code changes.
 * The server remembers the total it returned; placing the order is refused if it moves.
 */
export function useQuote(locale: 'uk' | 'en', delivery: Delivery, promoCode: string): QuoteState {
  const [state, setState] = useState<QuoteState>({ status: 'loading' });
  const latest = useRef(0);

  useEffect(() => {
    const run = ++latest.current;
    setState({ status: 'loading' });
    void quoteAction({ locale, delivery, promoCode }).then((result) => {
      if (run !== latest.current) return; // a newer answer is on its way
      setState(
        result.ok
          ? { status: 'ready', summary: result.summary }
          : { status: 'error', code: result.code },
      );
    });
  }, [locale, delivery, promoCode]);

  return state;
}
