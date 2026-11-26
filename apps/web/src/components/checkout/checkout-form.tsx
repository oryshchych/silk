'use client';

import { href, paths } from '@/lib/paths';
import { useTranslations } from 'next-intl';
import { useCallback, useId, useRef, useState, useTransition } from 'react';

import { placeOrderAction, type PlaceOrderResult } from '@/actions/checkout';
import { messageCode } from '@/lib/error-codes';
import { fieldText } from '@/lib/form-text';

import { CityPicker } from './city-picker';
import { OrderSummary } from './order-summary';
import { useQuote } from './use-quote';

type Delivery = 'np_warehouse' | 'np_courier' | 'ukrposhta' | 'pickup';
type Payment = 'cod' | 'bank_transfer' | 'mono' | 'wayforpay';

const DELIVERY: readonly Delivery[] = ['np_warehouse', 'np_courier', 'ukrposhta', 'pickup'];
const GROUP = { delivery: 'delivery', payment: 'payment' } as const;
const FIELD_NAME = { terms: 'terms' } as const;
const FIELD = 'min-h-10 rounded-sm border border-border bg-surface px-3';
const RADIO =
  'flex min-h-10 cursor-pointer items-center gap-2 rounded-sm border border-border px-3 has-[:checked]:border-accent has-[:focus-visible]:outline-2';

function Radio<T extends string>({
  name,
  value,
  checked,
  label,
  onSelect,
}: {
  name: string;
  value: T;
  checked: boolean;
  label: string;
  onSelect: (value: T) => void;
}) {
  return (
    <label className={RADIO}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => {
          onSelect(value);
        }}
      />
      {label}
    </label>
  );
}

/** One page, three blocks (contact, delivery, payment) and a summary priced by the server. */
export function CheckoutForm({
  locale,
  payments,
}: {
  locale: 'uk' | 'en';
  /** Methods the shop accepts right now (from settings). */
  payments: readonly Payment[];
}) {
  const t = useTranslations('checkout');
  const ids = { name: useId(), email: useId(), phone: useId(), address: useId(), promo: useId() };
  const [delivery, setDelivery] = useState<Delivery>('np_warehouse');
  const [payment, setPayment] = useState<Payment | null>(payments[0] ?? null);
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState('');
  const point = useRef({ settlementRef: '', warehouseRef: '' });
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<PlaceOrderResult | null>(null);
  const [refresh, setRefresh] = useState(0);
  const quote = useQuote(locale, delivery, promo, refresh);
  const onPoint = useCallback((value: { settlementRef: string; warehouseRef: string }) => {
    point.current = value;
  }, []);

  function submit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (payment === null || pending) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string): string => fieldText(form, key);
    const needsCity = delivery === 'np_warehouse' || delivery === 'np_courier';
    start(async () => {
      const result = await placeOrderAction({
        locale,
        name: text('name'),
        email: text('email'),
        phone: text('phone'),
        delivery,
        ...(needsCity
          ? {
              settlementRef: point.current.settlementRef,
              ...(delivery === 'np_warehouse' ? { warehouseRef: point.current.warehouseRef } : {}),
            }
          : {}),
        ...(delivery === 'np_courier' || delivery === 'ukrposhta'
          ? { address: text('address') }
          : {}),
        payment,
        terms: form.get(FIELD_NAME.terms) === 'on',
        // Only a code the server accepted travels: a refused one would make the order impossible.
        promoCode: quote.status === 'ready' && quote.summary.promo?.accepted === true ? promo : '',
      });
      // A success redirects; whatever comes back is a refusal to show.
      setFailure(result);
      // The server holds the new total now; price again so the summary shows it, and keep the
      // button disabled until it does: the next press is the buyer's confirmation.
      if (result.kind === 'priceChanged') setRefresh((value) => value + 1);
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-8 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-8">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-lg font-medium">{t('contactTitle')}</legend>
          <label htmlFor={ids.name} className="flex flex-col gap-1 text-sm">
            {t('name')}
            <input id={ids.name} name="name" autoComplete="name" required className={FIELD} />
          </label>
          <label htmlFor={ids.email} className="flex flex-col gap-1 text-sm">
            {t('email')}
            <input
              id={ids.email}
              name="email"
              type="email"
              autoComplete="email"
              required
              className={FIELD}
            />
          </label>
          <label htmlFor={ids.phone} className="flex flex-col gap-1 text-sm">
            {t('phone')}
            <input
              id={ids.phone}
              name="phone"
              type="tel"
              autoComplete="tel"
              required
              aria-describedby={`${ids.phone}-hint`}
              className={FIELD}
            />
          </label>
          <p id={`${ids.phone}-hint`} className="text-xs text-text-muted">
            {t('phoneHint')}
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-lg font-medium">{t('deliveryTitle')}</legend>
          <div className="flex flex-wrap gap-2">
            {DELIVERY.map((method) => (
              <Radio
                key={method}
                name={GROUP.delivery}
                value={method}
                checked={delivery === method}
                label={t(`method.${method}`)}
                onSelect={(value) => {
                  setFailure(null);
                  setDelivery(value);
                }}
              />
            ))}
          </div>
          {delivery === 'np_warehouse' || delivery === 'np_courier' ? (
            <CityPicker needBranch={delivery === 'np_warehouse'} onChange={onPoint} />
          ) : null}
          {delivery === 'np_courier' || delivery === 'ukrposhta' ? (
            <label htmlFor={ids.address} className="flex flex-col gap-1 text-sm">
              {delivery === 'np_courier' ? t('courierAddress') : t('fullAddress')}
              <input id={ids.address} name="address" required className={FIELD} />
            </label>
          ) : null}
          {delivery === 'pickup' ? <p className="text-sm">{t('pickupNote')}</p> : null}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-lg font-medium">{t('paymentTitle')}</legend>
          <div className="flex flex-wrap gap-2">
            {payments.map((method) => (
              <Radio
                key={method}
                name={GROUP.payment}
                value={method}
                checked={payment === method}
                label={t(`pay.${method}`)}
                onSelect={(value) => {
                  setFailure(null);
                  setPayment(value);
                }}
              />
            ))}
          </div>
          {payment === 'cod' ? <p className="text-sm">{t('codHint')}</p> : null}
          {payment === 'bank_transfer' ? <p className="text-sm">{t('transferHint')}</p> : null}
        </fieldset>

        <div className="flex flex-col gap-2">
          <label htmlFor={ids.promo} className="text-sm">
            {t('promoLabel')}
          </label>
          <div className="flex gap-2">
            <input
              id={ids.promo}
              value={promoInput}
              maxLength={64}
              onChange={(event) => {
                setPromoInput(event.target.value);
              }}
              className={`${FIELD} flex-1`}
            />
            <button
              type="button"
              className="min-h-10 rounded-full border border-border px-4"
              onClick={() => {
                setFailure(null);
                setPromo(promoInput.trim());
              }}
            >
              {t('promoApply')}
            </button>
          </div>
          <div aria-live="polite" className="text-sm">
            {quote.status === 'ready' && quote.summary.promo !== null ? (
              <p>{quote.summary.promo.accepted ? t('promoApplied') : t('promoNotApplied')}</p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <OrderSummary quote={quote} />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name={FIELD_NAME.terms}
            required
            className="mt-0.5 size-6 shrink-0 focus-visible:outline-2"
          />
          <span>
            {t.rich('terms', {
              terms: (chunks) => (
                <a
                  href={href(locale, paths.legal('terms'))}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {chunks}
                </a>
              ),
              privacy: (chunks) => (
                <a
                  href={href(locale, paths.legal('privacy'))}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {chunks}
                </a>
              ),
            })}
          </span>
        </label>
        <div aria-live="assertive" role="status" className="text-sm text-danger">
          <Failure failure={failure} />
        </div>
        <button
          type="submit"
          disabled={pending || payment === null || quote.status !== 'ready'}
          className="min-h-11 rounded-full bg-accent px-6 text-accent-contrast disabled:opacity-50"
        >
          {pending ? t('placing') : t('place')}
        </button>
      </div>
    </form>
  );
}

function Failure({ failure }: { failure: PlaceOrderResult | null }) {
  const t = useTranslations('checkout');
  const te = useTranslations('errors.codes');
  if (failure === null) return null;
  if (failure.kind === 'priceChanged') {
    return <p>{t('priceChanged', { total: failure.newTotal })}</p>;
  }
  if (failure.kind === 'stock') {
    return (
      <div>
        <p>{te('CHECKOUT_INSUFFICIENT_STOCK')}</p>
        <ul className="list-disc pl-5">
          {failure.problems.map((problem) => (
            <li key={`${problem.name}-${problem.size}`}>
              {t('stockLine', { name: problem.name, size: problem.size })}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <p>{te(messageCode(failure.code))}</p>;
}
