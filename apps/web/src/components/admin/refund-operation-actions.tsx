'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef } from 'react';

import { resolveRefundAction, withdrawRefundAction } from '@/actions/admin-orders';

import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const field = 'mt-1 block min-h-11 rounded-md border border-border bg-surface px-3';
const button = 'min-h-11 min-w-11 rounded-md border border-border px-4 disabled:opacity-60';

/**
 * What a person may do with a refund that is not settled: withdraw one that was never sent, or
 * close one whose answer is unknown with what the provider's portal says (the outcome is theirs).
 */
export function RefundOperationActions({
  operationId,
  state,
}: {
  operationId: string;
  state: 'pending' | 'in_flight' | 'unknown';
}) {
  const t = useTranslations('admin.orders');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const outcomeRef = useRef<'succeeded' | 'failed'>('succeeded');
  const refresh = () => {
    router.refresh();
  };
  if (state === 'pending') {
    return (
      <span>
        <button
          type="button"
          disabled={pending}
          className={button}
          onClick={() => {
            setMessage(null);
            run(async () => await withdrawRefundAction({ operationId }), t('done'), refresh);
          }}
        >
          {t('withdrawRefund')}
        </button>
        <StatusLine message={message} />
      </span>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const submitter =
          event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
        const outcome =
          submitter instanceof HTMLButtonElement && submitter.value === 'failed'
            ? 'failed'
            : 'succeeded';
        const data = readForm(event.currentTarget);
        setMessage(null);
        run(
          async () =>
            await resolveRefundAction({ operationId, outcome, note: textOf(data, 'note') }),
          t('done'),
          refresh,
        );
      }}
    >
      <p className="basis-full text-sm text-text-muted">{t('resolveRefundHint')}</p>
      <label className="block grow">
        {t('resolveRefundNote')}
        <input name="note" required minLength={3} maxLength={200} className={`${field} w-full`} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className={button}
        onClick={() => {
          outcomeRef.current = 'succeeded';
        }}
      >
        {t('refundWasSent')}
      </button>
      <button
        type="submit"
        disabled={pending}
        className={button}
        onClick={() => {
          outcomeRef.current = 'failed';
        }}
      >
        {t('refundWasNot')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
