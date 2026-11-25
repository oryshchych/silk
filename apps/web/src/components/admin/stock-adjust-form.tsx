'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { adjustStockAction } from '@/actions/admin-stock';

import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const MODES = ['delta', 'set'] as const;
const REASONS = ['receipt', 'writeoff', 'stocktake', 'correction'] as const;

const field = 'min-h-11 rounded-md border border-border bg-surface px-2';

/** One form per variant row: a change (+/-) or a counted quantity, a reason, an optional note. */
export function StockAdjustForm({ variantId, label }: { variantId: string; label: string }) {
  const t = useTranslations('admin.stock');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  // One id per form submission: a double click or a retry after a lost answer changes the stock once.
  const modeLabel: Record<(typeof MODES)[number], string> = {
    delta: t('modeDelta'),
    set: t('modeSet'),
  };
  const reasonLabel: Record<(typeof REASONS)[number], string> = {
    receipt: t('reasonReceipt'),
    writeoff: t('reasonWriteoff'),
    stocktake: t('reasonStocktake'),
    correction: t('reasonCorrection'),
  };
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = readForm(form);
        setMessage(null);
        run(
          async () =>
            await adjustStockAction({
              variantId,
              mode: textOf(data, 'mode'),
              amount: Number(textOf(data, 'amount')),
              reason: textOf(data, 'reason'),
              note: textOf(data, 'note'),
              requestId,
            }),
          t('saved'),
          () => {
            form.reset();
            setRequestId(crypto.randomUUID());
            router.refresh();
          },
        );
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <label className="block">
        <span className="sr-only">
          {t('mode')} {label}
        </span>
        <select name="mode" defaultValue="delta" className={field}>
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {modeLabel[mode]}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="sr-only">
          {t('amount')} {label}
        </span>
        <input
          name="amount"
          type="number"
          step={1}
          min={-1000000}
          max={1000000}
          required
          className={`${field} w-24`}
        />
      </label>
      <label className="block">
        <span className="sr-only">
          {t('reason')} {label}
        </span>
        <select name="reason" defaultValue="receipt" className={field}>
          {REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {reasonLabel[reason]}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="sr-only">
          {t('note')} {label}
        </span>
        <input name="note" maxLength={500} placeholder={t('note')} className={`${field} w-40`} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 min-w-11 rounded-md border border-border px-3"
      >
        {t('apply')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
