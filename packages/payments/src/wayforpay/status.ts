import { z } from 'zod';

import type { PaymentStatus } from '../types.ts';

const PG_INT_MAX = 2_147_483_647;

/**
 * The callback body and the CHECK_STATUS answer share these fields. Only the ones in the signed
 * list drive anything; the rest (dates, fees, card data) are ignored and never stored.
 */
export const wayForPayPaymentSchema = z.object({
  merchantAccount: z.string().min(1).max(64),
  orderReference: z.string().min(1).max(64),
  merchantSignature: z.string().min(1).max(64),
  amount: z.union([z.number().nonnegative().max(PG_INT_MAX), z.string().max(16)]),
  currency: z.string().min(1).max(8),
  // A JSON null is an empty value (the signature joins it as an empty string).
  authCode: z.string().max(32).nullish(),
  cardPan: z.string().max(32).nullish(),
  transactionStatus: z.string().min(1).max(40),
  // `reason` is NOT in the signed list: it is accepted but never read (see failureTextOf).
  reason: z.unknown().optional(),
  reasonCode: z.union([z.number().int(), z.string().max(8)]),
});

export type WayForPayPayment = z.infer<typeof wayForPayPaymentSchema>;

/** The text of a signed number as the signature saw it. */
export const asSigned = (value: number | string): string => String(value);

/**
 * The failure text kept on an attempt: built from the SIGNED reason code only. WayForPay's own
 * `reason` text is unsigned, so anyone who holds one genuine message could swap it for markup.
 */
export function failureTextOf(reasonCode: number | string, status: string): string | null {
  if (String(reasonCode) === '1100' && status !== 'Declined') return null;
  const code = /^\d{1,6}$/.test(String(reasonCode)) ? String(reasonCode) : 'unknown';
  return `WayForPay reason code ${code}`;
}

/**
 * Fields of the callback and CHECK_STATUS signature, in the documented order. `amountText` is the
 * amount as written in the message; without it the parsed value's own text is used.
 */
export function paymentSignatureFields(p: WayForPayPayment, amountText?: string): string[] {
  return [
    p.merchantAccount,
    p.orderReference,
    amountText ?? asSigned(p.amount),
    p.currency,
    p.authCode ?? '',
    p.cardPan ?? '',
    p.transactionStatus,
    asSigned(p.reasonCode),
  ];
}

/**
 * WayForPay `transactionStatus`: Created, InProcessing, WaitingAuthComplete, Approved, Pending,
 * Expired, Refunded, Voided, Declined, RefundInProcessing. An unknown value is never success.
 */
export function mapWayForPayStatus(status: string): PaymentStatus {
  switch (status) {
    case 'Approved':
      return 'paid';
    case 'WaitingAuthComplete':
      return 'authorized';
    case 'Declined':
      return 'failed';
    case 'Expired':
      return 'expired';
    case 'Refunded':
    case 'Voided':
      return 'refunded';
    default:
      // Created, InProcessing, Pending, RefundInProcessing and anything new.
      return 'pending';
  }
}
