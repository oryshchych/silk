/**
 * Provider-neutral fiscal receipt contract (ADR-16). Fiscalisation never blocks a payment: the
 * caller runs it from a queue job AFTER the order is paid (or, for cash on delivery, from the
 * shipping flow), retries with backoff and records `fiscal_status = 'failed'` plus an alert when
 * the retries run out. Like PaymentProvider: plain values in, plain values out, no database types.
 */
import type { Money } from '@store/shared/money';

export interface FiscalItem {
  /** SKU or another stable code of the good. */
  code: string;
  name: string;
  unitPrice: Money;
  /** Whole units. */
  quantity: number;
  /** UKTZED code when the accountant requires it on the receipt. */
  uktzed?: string;
}

/** How the buyer paid: a card online ("Безготівка") or cash on delivery ("Післяплата"). */
export type FiscalPaymentForm = 'card' | 'cash_on_delivery';

export interface FiscalSaleRequest {
  /** Our reference; the receipt id at the provider, so a repeat never makes a second receipt. */
  localReference: string;
  items: readonly FiscalItem[];
  /** What the buyer paid; must equal the sum of the items (the provider refuses a mismatch). */
  total: Money;
  paymentForm: FiscalPaymentForm;
  /** The electronic receipt is delivered here when present. */
  buyerEmail: string | null;
}

export interface FiscalReturnRequest extends FiscalSaleRequest {
  /** The provider's id of the primary sale receipt: a return always points at it. */
  parentProviderId: string;
  /** Its fiscal number, printed on the return receipt. */
  parentFiscalNumber: string;
}

export type FiscalResult =
  | { state: 'issued'; providerId: string; fiscalNumber: string; receiptUrl: string | null }
  /** Accepted, fiscal number not assigned yet: look again with `getReceipt`. */
  | { state: 'in_flight'; providerId: string }
  /** A definite refusal (validation, closed shift that cannot be opened): retrying will not help. */
  | { state: 'failed'; error: string }
  /** Timeout: the receipt may exist. Look it up by `localReference`, never blindly resend. */
  | { state: 'unknown'; error: string };

export type FiscalLookup =
  | { found: false }
  | { found: true; result: Extract<FiscalResult, { state: 'issued' | 'in_flight' | 'failed' }> };

export interface FiscalProvider {
  readonly code: 'checkbox';
  issueSale(request: FiscalSaleRequest): Promise<FiscalResult>;
  issueReturn(request: FiscalReturnRequest): Promise<FiscalResult>;
  /** By OUR reference (the receipt id): resolves an `unknown` or `in_flight` result. */
  lookup(localReference: string): Promise<FiscalLookup>;
}
