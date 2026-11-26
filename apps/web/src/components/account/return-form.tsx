'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import { requestReturnAction } from '@/actions/account-data';
import type { CustomerActionResult } from '@/lib/account/action';
import { fieldText } from '@/lib/form-text';
import { returnReasonValues, type EligibleOrderDto } from '@store/shared/dto/return';

const FIELD = 'min-h-10 rounded-sm border border-border bg-surface px-3';

/** Pick lines and units, a reason and a comment. Eligibility and the units left are checked again on the server. */
export function ReturnForm({ order }: { order: EligibleOrderDto }) {
  const t = useTranslations('account');
  const ids = { reason: useId(), comment: useId() };
  const [pending, start] = useTransition();
  const [result, setResult] = useState<CustomerActionResult<string> | null>(null);
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const items = order.items.flatMap((item) => {
          const quantity = Number(fieldText(form, `qty-${item.orderItemId}`));
          return quantity > 0 ? [{ orderItemId: item.orderItemId, quantity }] : [];
        });
        start(async () => {
          setResult(
            await requestReturnAction({
              orderNumber: order.orderNumber,
              reason: fieldText(form, 'reason'),
              comment: fieldText(form, 'comment'),
              items,
            }),
          );
        });
      }}
    >
      <ul className="flex flex-col gap-2">
        {order.items.map((item) => (
          <li key={item.orderItemId} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {item.name} ({item.sizeLabel})
            </span>
            <label className="flex items-center gap-2">
              <span className="sr-only">{t('returnQuantity')}</span>
              <input
                name={`qty-${item.orderItemId}`}
                type="number"
                min={0}
                max={item.remaining}
                defaultValue={0}
                className={`${FIELD} w-20`}
              />
              <span aria-hidden="true">/ {item.remaining}</span>
            </label>
          </li>
        ))}
      </ul>
      <label htmlFor={ids.reason} className="flex flex-col gap-1 text-sm">
        {t('returnReason')}
        <select id={ids.reason} name="reason" className={FIELD}>
          {returnReasonValues.map((reason) => (
            <option key={reason} value={reason}>
              {t(`reason.${reason}`)}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={ids.comment} className="flex flex-col gap-1 text-sm">
        {t('returnComment')}
        <textarea
          id={ids.comment}
          name="comment"
          maxLength={1000}
          rows={3}
          className={`${FIELD} py-2`}
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 w-fit rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {t('returnSubmit')}
      </button>
      <div aria-live="polite" className="min-h-6 text-sm">
        {result === null ? null : result.ok ? (
          <p>{t('returnSent')}</p>
        ) : (
          <p className="text-danger">
            {t(
              result.code === 'invalid' || result.code === 'notFound'
                ? 'returnInvalid'
                : 'error.error',
            )}
          </p>
        )}
      </div>
    </form>
  );
}
