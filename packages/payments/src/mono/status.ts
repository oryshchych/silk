import { z } from 'zod';

import { money, type Money } from '@store/shared/money';

import type { PaymentStatus } from '../types.ts';

const PG_INT_MAX = 2_147_483_647;

/**
 * Body of the Mono webhook and of the invoice status response (same shape).
 * Only fields we rely on are declared; unknown ones are ignored, and since the
 * whole body is covered by the signature none of them can be forged.
 */
export const monoInvoiceSchema = z.object({
  invoiceId: z.string().min(1),
  status: z.string().min(1),
  /** Kopiykas. */
  amount: z.number().int().positive().max(PG_INT_MAX),
  ccy: z.number().int(),
  /** Captured amount, present once the payment is final. */
  finalAmount: z.number().int().min(0).max(PG_INT_MAX).optional(),
  reference: z.string().optional(),
  failureReason: z.string().optional(),
  modifiedDate: z.string().optional(),
});

export type MonoInvoice = z.infer<typeof monoInvoiceSchema>;

export const MONO_CURRENCY_UAH = 980;

/** Mono statuses: created, processing, hold, success, failure, reversed, expired. */
export function mapMonoStatus(status: string): PaymentStatus {
  switch (status) {
    case 'created':
    case 'processing':
      return 'pending';
    case 'hold':
      return 'authorized';
    case 'success':
      return 'paid';
    case 'failure':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'reversed':
      // Whether a reversal is full or partial is not visible here; the domain
      // drives refund state from refund_operations (ADR-4 source 4), and treats this as a hint.
      return 'refunded';
    default:
      // An unknown status must not be read as success. It stays pending until reconciled.
      return 'pending';
  }
}

/**
 * Captured money. A `success` without `finalAmount`, or one that captured more
 * than the invoice, is not trusted: null, and the caller treats the message as invalid.
 */
export function capturedAmountOf(invoice: MonoInvoice, status: PaymentStatus): Money | null {
  if (status !== 'paid') return money(0);
  if (invoice.finalAmount === undefined || invoice.finalAmount > invoice.amount) return null;
  return money(invoice.finalAmount);
}

export function stateVersionOf(invoice: MonoInvoice): Date | null {
  if (invoice.modifiedDate === undefined) return null;
  const date = new Date(invoice.modifiedDate);
  return Number.isNaN(date.getTime()) ? null : date;
}
