'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import {
  approveReturnAction,
  closeReturnAction,
  receiveReturnAction,
  refundReturnAction,
  rejectReturnAction,
} from '@/actions/admin-returns';
import type { AdminReturnDto } from '@store/shared/dto/return';

import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const field = 'mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3';
const button = 'min-h-11 min-w-11 rounded-md border border-border px-4 disabled:opacity-60';

/** The buttons a status allows. Every one is checked again by the action and by the database. */
export function ReturnActions({ dto, canRefund }: { dto: AdminReturnDto; canRefund: boolean }) {
  const t = useTranslations('admin.returns');
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  const done = () => {
    router.refresh();
  };
  return (
    <div className="flex flex-col gap-4">
      {dto.status === 'requested' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = readForm(event.currentTarget);
            run(
              async () =>
                await approveReturnAction({
                  id: dto.id,
                  restock: data.get('restock') === 'on',
                  note: textOf(data, 'note'),
                }),
              t('saved'),
              done,
            );
          }}
        >
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              name="restock"
              defaultChecked={dto.reason !== 'defect'}
              className="size-5"
            />
            {t('restock')}
          </label>
          <label className="block text-sm">
            {t('note')}
            <input name="note" maxLength={1000} className={field} />
          </label>
          <button type="submit" disabled={pending} className={`${button} w-fit`}>
            {t('approve')}
          </button>
        </form>
      ) : null}
      {dto.status === 'requested' || dto.status === 'approved' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = readForm(event.currentTarget);
            run(
              async () => await rejectReturnAction({ id: dto.id, note: textOf(data, 'note') }),
              t('saved'),
              done,
            );
          }}
        >
          <label className="block text-sm">
            {t('note')}
            <input name="note" maxLength={1000} className={field} />
          </label>
          <button type="submit" disabled={pending} className={`${button} w-fit`}>
            {t('reject')}
          </button>
        </form>
      ) : null}
      {dto.status === 'approved' || dto.status === 'received' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = readForm(event.currentTarget);
            run(
              async () =>
                await receiveReturnAction({
                  id: dto.id,
                  items: dto.items.map((item) => ({
                    itemId: item.id,
                    receivedQuantity: Number(textOf(data, `recv-${item.id}`)),
                  })),
                }),
              t('saved'),
              done,
            );
          }}
        >
          <p className="text-sm text-text-muted">{t('receiveHint')}</p>
          {dto.items.map((item) => (
            <label key={item.id} className="block text-sm">
              {item.name} ({item.sizeLabel}), {t('receivedTotal')}
              <input
                name={`recv-${item.id}`}
                type="number"
                min={item.receivedQuantity}
                max={item.quantity}
                defaultValue={item.receivedQuantity}
                className={field}
              />
            </label>
          ))}
          <button type="submit" disabled={pending} className={`${button} w-fit`}>
            {t('receive')}
          </button>
        </form>
      ) : null}
      {dto.status === 'received' && dto.refundState === null ? (
        <div className="flex flex-wrap gap-2">
          {canRefund ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                run(async () => await refundReturnAction({ id: dto.id }), t('saved'), done);
              }}
              className={button}
            >
              {t('refund')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              run(async () => await closeReturnAction({ id: dto.id }), t('saved'), done);
            }}
            className={button}
          >
            {t('close')}
          </button>
        </div>
      ) : null}
      <StatusLine message={message} />
    </div>
  );
}
