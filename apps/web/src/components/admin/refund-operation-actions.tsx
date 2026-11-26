'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { resolveRefundAction, withdrawRefundAction } from '@/actions/admin-orders';

import { StatusLine } from './fields';
import { OUTCOME_FIELD, REFUND_OUTCOMES, resolvePayload } from '@/lib/admin/refund-resolution';

import { textOf, useAdminAction } from './use-admin-action';

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
        // The clicked button's own name and value travel in the form data: nothing else decides the outcome.
        const submitter =
          event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
        const data = new FormData(event.currentTarget, submitter);
        const payload = resolvePayload(operationId, data.get(OUTCOME_FIELD), textOf(data, 'note'));
        if (payload === null) return;
        setMessage(null);
        run(async () => await resolveRefundAction(payload), t('done'), refresh);
      }}
    >
      <p className="basis-full text-sm text-text-muted">{t('resolveRefundHint')}</p>
      <label className="block grow">
        {t('resolveRefundNote')}
        <input name="note" required minLength={3} maxLength={200} className={`${field} w-full`} />
      </label>
      <button
        type="submit"
        name={OUTCOME_FIELD}
        value={REFUND_OUTCOMES.sent}
        disabled={pending}
        className={button}
      >
        {t('refundWasSent')}
      </button>
      <button
        type="submit"
        name={OUTCOME_FIELD}
        value={REFUND_OUTCOMES.notSent}
        disabled={pending}
        className={button}
      >
        {t('refundWasNot')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
