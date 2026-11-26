'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { refundOrderAction } from '@/actions/admin-orders';

import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const field = 'mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3';

export interface RefundableAttempt {
  id: string;
  label: string;
}

/** An empty amount refunds everything that is left; the provider's answer, not this form, moves the status. */
export function OrderRefundForm({
  orderId,
  attempts,
}: {
  orderId: string;
  attempts: RefundableAttempt[];
}) {
  const t = useTranslations('admin.orders');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3"
      aria-labelledby="refund-title"
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        const amount = textOf(data, 'amount').trim();
        const attemptId = textOf(data, 'attemptId');
        setMessage(null);
        run(
          async () =>
            await refundOrderAction({
              orderId,
              reason: textOf(data, 'reason'),
              ...(amount === '' ? {} : { amount }),
              ...(attemptId === '' ? {} : { attemptId }),
            }),
          t('refundStarted'),
          () => {
            router.refresh();
          },
        );
      }}
    >
      <h3 id="refund-title" className="basis-full font-medium">
        {t('refund')}
      </h3>
      <label className="block">
        {t('refundAmount')}
        <input name="amount" inputMode="decimal" maxLength={16} className={field} />
      </label>
      {attempts.length > 1 ? (
        <label className="block">
          {t('refundPayment')}
          <select name="attemptId" className={field}>
            {attempts.map((attempt) => (
              <option key={attempt.id} value={attempt.id}>
                {attempt.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="block grow">
        {t('refundReason')}
        <input name="reason" required minLength={3} maxLength={200} className={field} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 min-w-11 rounded-md border border-border px-4 disabled:opacity-60"
      >
        {t('refundSubmit')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
