'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { editOrderItemsAction } from '@/actions/admin-orders';

import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const field = 'mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3';

export interface EditableItem {
  id: string;
  label: string;
  quantity: number;
}

/** Quantities per line (0 takes the line off) and a reason; only the lines that changed are sent. */
export function OrderItemsEditor({ orderId, items }: { orderId: string; items: EditableItem[] }) {
  const t = useTranslations('admin.orders');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  return (
    <form
      className="mt-4 space-y-3"
      aria-labelledby="edit-items"
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        const changes = items.flatMap((item) => {
          const quantity = Number(textOf(data, `qty-${item.id}`));
          return quantity === item.quantity ? [] : [{ itemId: item.id, quantity }];
        });
        setMessage(null);
        run(
          async () =>
            await editOrderItemsAction({ orderId, changes, reason: textOf(data, 'reason') }),
          t('done'),
          () => {
            router.refresh();
          },
        );
      }}
    >
      <h3 id="edit-items" className="font-medium">
        {t('editItems')}
      </h3>
      {items.map((item) => (
        <label key={item.id} className="block">
          {item.label}
          <input
            name={`qty-${item.id}`}
            type="number"
            min={0}
            max={1000}
            step={1}
            defaultValue={item.quantity}
            required
            className={`${field} max-w-32`}
          />
        </label>
      ))}
      <p className="text-sm text-text-muted">{t('editHint')}</p>
      <label className="block">
        {t('editReason')}
        <input name="reason" required minLength={3} maxLength={300} className={field} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 min-w-11 rounded-md border border-border px-4 disabled:opacity-60"
      >
        {t('saveItems')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
