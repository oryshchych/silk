'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

const KNOWN_CODES = [
  'GENERIC',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'INVALID_INPUT',
  'BAD_ORIGIN',
  'ADMIN_NOT_FOUND',
  'ADMIN_SLUG_TAKEN',
  'ADMIN_SKU_TAKEN',
  'ADMIN_INVALID_PRICE',
  'ADMIN_NOT_PUBLISHABLE',
  'ADMIN_TOO_MANY_VARIANTS',
  'ADMIN_DUPLICATE',
  'ADMIN_BARCODE_TAKEN',
  'ADMIN_TOO_MANY_IMAGES',
  'ADMIN_CATEGORY_CYCLE',
  'ADMIN_CATEGORY_TOO_DEEP',
  'STOCK_BELOW_ZERO',
  'STOCK_BELOW_RESERVED',
  'STOCK_ABOVE_MAX',
  'STOCK_REQUEST_REUSED',
  'STOCK_VARIANT_NOT_FOUND',
  'STOCK_INVALID_CHANGE',
  'ORDER_NOT_SHIPPABLE',
  'ORDER_NOT_CANCELLABLE',
  'ORDER_NOT_CONFIRMABLE',
  'ORDER_TRANSITION_INVALID',
  'TRANSFER_AMOUNT_MISMATCH',
  'STOCK_COUNTER_DRIFT',
  'REFUND_BUDGET_EXCEEDED',
  'REFUND_NO_PROVIDER',
  'REFUND_NOT_ALLOWED',
  'CHECKOUT_INSUFFICIENT_STOCK',
  'ORDER_PAYMENT_OPEN',
  'WAYBILL_NOT_ALLOWED',
  'WAYBILL_IN_PROGRESS',
  'WAYBILL_NOT_CONFIGURED',
  'ORDER_HAS_WAYBILL',
] as const;

export type ActionOutcome = { ok: true; data?: unknown } | { ok: false; code: string };
export interface FormMessage {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * Runs an admin action from a form: shows the result in a live region, maps a failure code to its
 * message (an unknown code becomes the generic one: a code is never shown as is).
 */
export function useAdminAction() {
  const t = useTranslations('admin.errors');
  const [message, setMessage] = useState<FormMessage | null>(null);
  const [pending, startTransition] = useTransition();

  function run(
    action: () => Promise<ActionOutcome>,
    okText: string | ((data: unknown) => string),
    onOk?: () => void,
  ): void {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage({ kind: 'ok', text: typeof okText === 'string' ? okText : okText(result.data) });
        onOk?.();
      } else {
        const known = KNOWN_CODES.find((code) => code === result.code) ?? 'GENERIC';
        setMessage({ kind: 'error', text: t(known) });
      }
    });
  }
  return { message, pending, run, setMessage };
}

/** The text fields of a form as strings; a checkbox is `true` when checked. */
export function readForm(form: HTMLFormElement): FormData {
  return new FormData(form);
}

export const textOf = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
};

/** `data[key]` when `data` is an object that has it, else undefined (an action's data arrives as unknown). */
export function dataField(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null
    ? Object.entries(data).find(([name]) => name === key)?.[1]
    : undefined;
}
