'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import {
  addOrderNoteAction,
  cancelOrderAction,
  confirmOrderAction,
  confirmTransferAction,
  deliverOrderAction,
  processOrderAction,
  shipOrderAction,
} from '@/actions/admin-orders';

import { StatusLine } from './fields';
import { dataField, readForm, textOf, useAdminAction } from './use-admin-action';

type Step = 'confirm' | 'process' | 'ship' | 'deliver';
const RUNNERS = {
  confirm: confirmOrderAction,
  process: processOrderAction,
  ship: shipOrderAction,
  deliver: deliverOrderAction,
} as const;

const field = 'mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3';
const button = 'min-h-11 min-w-11 rounded-md border border-border px-4 disabled:opacity-60';

export interface OrderActionsProps {
  orderId: string;
  /** What the state offers, already filtered by the viewer's permissions. */
  steps: Step[];
  canCancel: boolean;
  canNote: boolean;
  /** Offer "transfer received": a transfer order that is not paid yet, for a role that may confirm it. */
  canConfirmTransfer: boolean;
  /** Money was received: cancelling does not give it back, a refund is a separate step. */
  hasReceivedMoney: boolean;
}

/** The workflow buttons, the cancellation form (a comment is required) and the internal note. */
export function OrderActions(props: OrderActionsProps) {
  const t = useTranslations('admin.orders');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const refresh = () => {
    router.refresh();
  };
  return (
    <section aria-labelledby="order-actions" className="mt-6 space-y-4">
      <h2 id="order-actions" className="text-lg font-semibold">
        {t('actions')}
      </h2>
      <div className="flex flex-wrap gap-3">
        {props.steps.map((step) => (
          <button
            key={step}
            type="button"
            disabled={pending}
            className={button}
            onClick={() => {
              setMessage(null);
              run(async () => await RUNNERS[step]({ orderId: props.orderId }), t('done'), refresh);
            }}
          >
            {t(`step.${step}`)}
          </button>
        ))}
      </div>
      {props.canConfirmTransfer ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = readForm(event.currentTarget);
            setMessage(null);
            run(
              async () =>
                await confirmTransferAction({
                  orderId: props.orderId,
                  bankReference: textOf(data, 'bankReference'),
                  amount: textOf(data, 'amount'),
                }),
              t('done'),
              refresh,
            );
          }}
        >
          <label className="block">
            {t('bankReference')}
            <input name="bankReference" required maxLength={128} className={field} />
          </label>
          <label className="block">
            {t('receivedAmount')}
            <input name="amount" required inputMode="decimal" maxLength={16} className={field} />
          </label>
          <button type="submit" disabled={pending} className={button}>
            {t('confirmTransfer')}
          </button>
        </form>
      ) : null}
      {props.canCancel ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = readForm(event.currentTarget);
            setMessage(null);
            run(
              async () =>
                await cancelOrderAction({ orderId: props.orderId, reason: textOf(data, 'reason') }),
              (result) => {
                const due = dataField(result, 'refundDue');
                const hold = dataField(result, 'heldAuthorization');
                return (typeof due === 'number' && due > 0) || hold === true
                  ? t('cancelledRefundDue')
                  : t('done');
              },
              refresh,
            );
          }}
        >
          <label className="block grow">
            {t('cancelReason')}
            <input name="reason" required minLength={3} maxLength={500} className={field} />
          </label>
          {props.hasReceivedMoney ? (
            <p className="basis-full text-sm text-text-muted">{t('cancelRefundWarning')}</p>
          ) : null}
          <button type="submit" disabled={pending} className={button}>
            {t('step.cancel')}
          </button>
        </form>
      ) : null}
      {props.canNote ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = readForm(form);
            setMessage(null);
            run(
              async () =>
                await addOrderNoteAction({ orderId: props.orderId, text: textOf(data, 'text') }),
              t('done'),
              () => {
                form.reset();
                refresh();
              },
            );
          }}
        >
          <label className="block grow">
            {t('noteLabel')}
            <input name="text" required maxLength={1000} className={field} />
          </label>
          <button type="submit" disabled={pending} className={button}>
            {t('addNote')}
          </button>
        </form>
      ) : null}
      <StatusLine message={message} />
    </section>
  );
}
