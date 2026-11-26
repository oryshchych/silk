'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { createWaybillAction, resolveWaybillAction } from '@/actions/admin-orders';

import { StatusLine } from './fields';
import { dataField, readForm, textOf, useAdminAction } from './use-admin-action';

const RESOLUTIONS = ['attach', 'none'] as const;
const field = 'mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3';
const button = 'min-h-11 min-w-11 rounded-md border border-border px-4 disabled:opacity-60';

export interface OrderWaybillProps {
  orderId: string;
  ttn: string | null;
  trackingUrl: string | null;
  /** The latest operation: `in_flight` and `unknown` mean a call may have made a document. */
  shipmentState: string | null;
  shipmentError: string | null;
  canCreate: boolean;
}

/** The waybill of the order: create it, open its tracking page, print it, or close an unknown one by hand. */
export function OrderWaybill(props: OrderWaybillProps) {
  const t = useTranslations('admin.orders');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const [resolveKind, setResolveKind] = useState<'attach' | 'none'>('attach');
  const refresh = () => {
    router.refresh();
  };
  const live = props.shipmentState === 'in_flight' || props.shipmentState === 'unknown';
  return (
    <section aria-labelledby="order-waybill" className="mt-6 space-y-3">
      <h2 id="order-waybill" className="text-lg font-semibold">
        {t('waybill')}
      </h2>
      {props.ttn !== null ? (
        <p>
          {t('waybillNumber')}: <strong>{props.ttn}</strong>
          {props.trackingUrl === null ? null : (
            <>
              {' · '}
              <a
                className="inline-flex min-h-11 items-center underline"
                href={props.trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('tracking')}
              </a>
            </>
          )}
          {' · '}
          <a
            className="inline-flex min-h-11 items-center underline"
            href={`/admin/print/waybill/${props.orderId}?kind=document`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('printWaybill')}
          </a>
          {' · '}
          <a
            className="inline-flex min-h-11 items-center underline"
            href={`/admin/print/waybill/${props.orderId}?kind=marking`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('printSticker')}
          </a>
        </p>
      ) : null}
      {props.ttn === null && !live && props.canCreate ? (
        <button
          type="button"
          disabled={pending}
          className={button}
          onClick={() => {
            setMessage(null);
            run(
              async () => await createWaybillAction({ orderId: props.orderId }),
              (data) =>
                dataField(data, 'state') === 'succeeded'
                  ? t('waybillCreated')
                  : dataField(data, 'state') === 'unknown'
                    ? t('waybillUnknown')
                    : t('waybillFailed'),
              refresh,
            );
          }}
        >
          {t('createWaybill')}
        </button>
      ) : null}
      {live && props.ttn === null ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = readForm(event.currentTarget);
            setMessage(null);
            run(
              async () =>
                await resolveWaybillAction({
                  orderId: props.orderId,
                  resolution:
                    resolveKind === 'attach'
                      ? { kind: 'attach', ttn: textOf(data, 'ttn') }
                      : { kind: 'none' },
                }),
              t('done'),
              refresh,
            );
          }}
        >
          <p role="alert">{t('waybillNeedsCheck')}</p>
          <label className="block">
            {t('resolveKind')}
            <select
              className={field}
              value={resolveKind}
              onChange={(event) => {
                setResolveKind(event.currentTarget.value === 'none' ? 'none' : 'attach');
              }}
            >
              {RESOLUTIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind === 'attach' ? t('resolveAttach') : t('resolveNone')}
                </option>
              ))}
            </select>
          </label>
          {resolveKind === 'attach' ? (
            <label className="block">
              {t('waybillNumber')}
              <input
                name="ttn"
                required
                inputMode="numeric"
                pattern="\d{14}"
                maxLength={14}
                className={field}
              />
            </label>
          ) : null}
          <button type="submit" disabled={pending} className={button}>
            {t('resolveSubmit')}
          </button>
        </form>
      ) : null}
      {props.shipmentError !== null && props.shipmentState === 'failed' ? (
        <p className="text-sm text-text-muted">
          {t('lastError')}: {props.shipmentError}
        </p>
      ) : null}
      <StatusLine message={message} />
    </section>
  );
}
