/**
 * Provider-neutral payment contract (docs/architecture/05-payment-flow.md).
 *
 * Deliberately free of database types: a provider adapter receives plain
 * values and returns plain values. The domain (packages/core) decides what to
 * persist. Do not unify Mono and WayForPay beyond this surface: Mono verifies
 * the original body bytes with ECDSA, WayForPay signs a defined field set and
 * needs a signed acknowledgement (AGENTS.md 4b.2).
 */
import type { Money } from '@store/shared/money';

export type PaymentStatus =
  'pending' | 'authorized' | 'paid' | 'failed' | 'expired' | 'refunded' | 'partially_refunded';

/** A payment ATTEMPT (not an order): it already exists locally with an immutable reference. */
export interface PaymentAttemptRef {
  /** Our reference, sent to the provider BEFORE the external call (ADR-11). */
  localReference: string;
  amount: Money;
  currency: 'UAH';
  description: string;
  redirectUrl: string;
  webhookUrl: string;
  /** How long the payment page stays valid. */
  validitySeconds: number;
}

export type CreatePaymentResult =
  | { ok: true; redirectUrl: string; externalId: string }
  /**
   * The call was made but the answer was lost (timeout, dropped connection).
   * NOT an error: the next step is reconciliation, never a second invoice.
   */
  | { ok: false; externalIdUnknown: true };

export interface PaymentStatusResult {
  externalId: string;
  /** Null when the provider did not echo our reference. */
  localReference: string | null;
  currency: string;
  status: PaymentStatus;
  amount: Money;
  /** Money actually captured; zero until paid. */
  capturedAmount: Money;
  /** Provider-side version of the state (Mono: `modifiedDate`). Order is not guaranteed. */
  stateVersion: Date | null;
  failureReason: string | null;
}

/** A webhook that passed signature verification. Nothing here is trusted before that. */
export interface WebhookResult {
  /** Deduplicates the MESSAGE (not the attempt); built from authenticated fields only. */
  messageKey: string;
  externalId: string;
  localReference: string;
  eventType: string;
  status: PaymentStatus;
  amount: Money;
  capturedAmount: Money;
  currency: string;
  stateVersion: Date | null;
  failureReason: string | null;
  /** The parsed body, stored in payment_events.raw_payload. */
  rawPayload: unknown;
}

export interface RefundRequest {
  /** Our reference for this refund operation, sent to the provider. */
  localReference: string;
  /** The provider's id of the payment being refunded (routing by attempt, GIFT_CARDS.md section 0). */
  externalId: string;
  amount: Money;
}

export type RefundResult =
  | { state: 'succeeded'; providerReference: string | null }
  | { state: 'in_flight'; providerReference: string | null }
  | { state: 'failed'; error: string }
  /** Timeout: the refund may or may not have happened. Reconcile, never retry blindly. */
  | { state: 'unknown'; error: string };

export interface PaymentProvider {
  readonly code: 'mono' | 'wayforpay';

  /**
   * What `getPaymentStatus` is keyed by. Mono looks an invoice up by its own `invoiceId`
   * (unknown if the create answer was lost); WayForPay looks a payment up by OUR reference,
   * so even a lost create answer can be reconciled.
   */
  readonly statusLookupKey: 'externalId' | 'localReference';

  /**
   * Whether a URL is a payment page of this provider (https, its own domain or a configured
   * sandbox host). The answer's URL is checked before it is stored and again before a buyer is
   * redirected to it.
   */
  isPaymentPage(url: string): boolean;

  createPayment(attempt: PaymentAttemptRef): Promise<CreatePaymentResult>;

  /** Active reconciliation (ADR-4): a webhook may never arrive. */
  getPaymentStatus(externalId: string): Promise<PaymentStatusResult>;

  /**
   * Verifies the signature over the ORIGINAL BYTES of the body (read with
   * `arrayBuffer()`, not `text()`: decoding can change bytes) before any
   * parsing or normalisation. Returns null for anything that does not verify. Fails
   * closed: a missing key or header is `null`.
   *
   * `null` also covers a merchant key that could not be fetched: a genuine webhook can be
   * refused for up to 30 s after a failed key fetch and for the rotation window after a key
   * change. The caller therefore quarantines it AND answers a NON-2xx status, so the
   * provider redelivers instead of treating the message as delivered.
   *
   * Core notes: `reversed` maps to `refunded` with `capturedAmount` 0 (a zero capture on a
   * refunded payment is not "never paid"); a non-UAH `currency` must be rejected in core.
   */
  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<WebhookResult | null>;

  refund(request: RefundRequest): Promise<RefundResult>;

  /**
   * Called ALWAYS, including for duplicates (WayForPay retries for hours otherwise). A duplicate
   * still carries the verified message: the signed answer names its order reference.
   */
  buildWebhookResponse(result: WebhookResult | { duplicate: true; of: WebhookResult }): Response;
}

/**
 * A provider answer we could not use: a definite refusal (400, 401, 403, 404,
 * 422) or a failed read-only lookup. Never thrown for an ambiguous write.
 */
export class PaymentProviderError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PaymentProviderError';
    this.status = status;
  }
}
