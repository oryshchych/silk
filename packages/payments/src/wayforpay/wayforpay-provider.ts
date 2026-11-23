/**
 * WayForPay adapter, written from the public API description (HMAC_MD5 over a defined field
 * list, JSON API at /api, callback answered with a signed `accept`). Not yet run against the
 * real sandbox: merchant credentials do not exist yet (OWNER_QUEUE), tests use a local fake that
 * signs the documented way.
 *
 * The payment identity is OUR `orderReference` (the attempt's local reference), so unlike Mono a
 * lost create answer can be reconciled by asking for that reference.
 *
 * What is NOT signed is not trusted: the callback signature covers merchantAccount,
 * orderReference, amount, currency, authCode, cardPan, transactionStatus and reasonCode. Dates,
 * fee and card details are ignored; the dedup key is built from the signed fields only, and the
 * message has no version, so ordering is protected by the attempt's allowed transitions.
 */
import { money } from '@store/shared/money';

import {
  PaymentProviderError,
  type CreatePaymentResult,
  type PaymentAttemptRef,
  type PaymentProvider,
  type PaymentStatusResult,
  type RefundRequest,
  type RefundResult,
  type WebhookResult,
} from '../types.ts';
import { readJsonCapped, readTextCapped } from '../http.ts';
import {
  amountTokens,
  fromWayForPayAmount,
  hmacMd5,
  signatureMatches,
  toWayForPayAmount,
} from './signature.ts';
import {
  asSigned,
  failureTextOf,
  mapWayForPayStatus,
  paymentSignatureFields,
  wayForPayPaymentSchema,
  type WayForPayPayment,
} from './status.ts';

export interface WayForPayConfig {
  /** https://api.wayforpay.com in production. Plain http is accepted for loopback only. */
  baseUrl: string;
  merchantAccount: string;
  /** The merchant secret key. Server-only. */
  secretKey: string;
  /** The shop's domain as registered with WayForPay (part of the invoice signature). */
  merchantDomainName: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Unix seconds; a parameter so tests control the signed `time`. */
  now?: () => number;
}

const REASON_OK = 1100;
const REASON_ORDER_NOT_FOUND = 1121;
const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

function assertPositiveMoney(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError('payment amounts must be positive whole kopiykas');
  }
}

const reasonCodeOf = (body: unknown): number | null => {
  if (typeof body !== 'object' || body === null || !('reasonCode' in body)) return null;
  const code = Number(body.reasonCode);
  return Number.isInteger(code) ? code : null;
};

export class WayForPayProvider implements PaymentProvider {
  readonly code = 'wayforpay';
  readonly statusLookupKey = 'localReference';

  private readonly config: WayForPayConfig;
  private readonly http: typeof fetch;

  constructor(config: WayForPayConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
      throw new Error('WayForPay base URL must be https');
    }
    if (config.merchantAccount === '' || config.secretKey === '') {
      throw new Error('WayForPay needs a merchant account and a secret key');
    }
    this.config = config;
    this.http = config.fetch ?? fetch;
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    return await this.http(`${this.config.baseUrl}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, apiVersion: 1 }),
      // A redirect would resend the signed body to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    });
  }

  async createPayment(attempt: PaymentAttemptRef): Promise<CreatePaymentResult> {
    assertPositiveMoney(attempt.amount);
    const { merchantAccount, merchantDomainName, secretKey } = this.config;
    const orderDate = (this.config.now ?? (() => Math.floor(Date.now() / 1000)))();
    const amount = toWayForPayAmount(attempt.amount);
    const signature = hmacMd5(secretKey, [
      merchantAccount,
      merchantDomainName,
      attempt.localReference,
      String(orderDate),
      String(amount),
      attempt.currency,
      attempt.description,
      '1',
      String(amount),
    ]);
    let response: Response;
    try {
      response = await this.post({
        transactionType: 'CREATE_INVOICE',
        merchantAccount,
        merchantAuthType: 'SimpleSignature',
        merchantDomainName,
        merchantSignature: signature,
        orderReference: attempt.localReference,
        orderDate,
        amount,
        currency: attempt.currency,
        productName: [attempt.description],
        productCount: [1],
        productPrice: [amount],
        serviceUrl: attempt.webhookUrl,
        returnUrl: attempt.redirectUrl,
        orderTimeout: attempt.validitySeconds,
      });
    } catch {
      return { ok: false, externalIdUnknown: true };
    }
    // 4xx/5xx from a gateway or proxy can hide an executed write: unknown, reconcile by reference.
    if (!response.ok) return { ok: false, externalIdUnknown: true };
    let body: unknown;
    try {
      body = await readJsonCapped(response);
    } catch {
      return { ok: false, externalIdUnknown: true };
    }
    const reasonCode = reasonCodeOf(body);
    if (reasonCode !== null && reasonCode !== REASON_OK) {
      // A logical refusal by WayForPay: the invoice was not created.
      throw new PaymentProviderError('WayForPay rejected the invoice', 422);
    }
    if (
      reasonCode === null ||
      typeof body !== 'object' ||
      body === null ||
      !('invoiceUrl' in body) ||
      typeof body.invoiceUrl !== 'string'
    ) {
      return { ok: false, externalIdUnknown: true };
    }
    return { ok: true, redirectUrl: body.invoiceUrl, externalId: attempt.localReference };
  }

  /** `externalId` of this provider IS the order reference. */
  async getPaymentStatus(externalId: string): Promise<PaymentStatusResult> {
    try {
      return await this.readStatus(externalId);
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      throw new PaymentProviderError('WayForPay status lookup failed', 0);
    }
  }

  private async readStatus(orderReference: string): Promise<PaymentStatusResult> {
    const { merchantAccount, secretKey } = this.config;
    const response = await this.post({
      transactionType: 'CHECK_STATUS',
      merchantAccount,
      orderReference,
      merchantSignature: hmacMd5(secretKey, [merchantAccount, orderReference]),
    });
    if (!response.ok) {
      throw new PaymentProviderError('WayForPay status lookup failed', response.status);
    }
    const text = await readTextCapped(response);
    const json: unknown = JSON.parse(text);
    if (reasonCodeOf(json) === REASON_ORDER_NOT_FOUND) {
      // No payment exists for this reference: a definite answer, not a transport failure.
      throw new PaymentProviderError('WayForPay has no such order', 404);
    }
    const parsed = wayForPayPaymentSchema.safeParse(json);
    if (!parsed.success) throw new PaymentProviderError('WayForPay answer unreadable', 502);
    const payment = parsed.data;
    if (
      payment.merchantAccount !== merchantAccount ||
      payment.orderReference !== orderReference ||
      !this.signedBy(secretKey, text, payment)
    ) {
      throw new PaymentProviderError('WayForPay answer did not verify', 502);
    }
    const normalised = this.normalise(payment);
    if (normalised === null) throw new PaymentProviderError('WayForPay amount invalid', 502);
    return {
      externalId: orderReference,
      localReference: orderReference,
      currency: normalised.currency,
      status: normalised.status,
      amount: normalised.amount,
      capturedAmount: normalised.capturedAmount,
      stateVersion: null,
      failureReason: failureTextOf(payment.reasonCode, payment.transactionStatus),
    };
  }

  private normalise(payment: WayForPayPayment) {
    const amount = fromWayForPayAmount(payment.amount);
    if (amount === null) return null;
    const status = mapWayForPayStatus(payment.transactionStatus);
    return {
      amount,
      status,
      currency: payment.currency,
      // Captured only when approved; a refunded payment reports 0 here (the refund ledger owns it).
      capturedAmount: status === 'paid' ? amount : money(0),
    };
  }

  verifyWebhook(rawBody: Uint8Array): Promise<WebhookResult | null> {
    return Promise.resolve(this.verifySync(rawBody));
  }

  /**
   * The signature covers the amount as WayForPay wrote it (`10.10` signs as "10.10", a parsed
   * number prints "10.1"): the text taken from the bytes is tried first, then the parsed value's.
   * A body with more than one `amount` is refused: JSON.parse keeps the last, a signature could
   * have covered the first.
   */
  private signedBy(secret: string, text: string, payment: WayForPayPayment): boolean {
    const tokens = amountTokens(text);
    if (tokens.length !== 1) return false;
    const candidates = new Set([tokens[0] ?? '', asSigned(payment.amount)]);
    return [...candidates].some((amountText) =>
      signatureMatches(
        secret,
        paymentSignatureFields(payment, amountText),
        payment.merchantSignature,
      ),
    );
  }

  private verifySync(rawBody: Uint8Array): WebhookResult | null {
    const text = Buffer.from(rawBody).toString('utf8');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = wayForPayPaymentSchema.safeParse(json);
    if (!parsed.success) return null;
    const payment = parsed.data;
    if (payment.merchantAccount !== this.config.merchantAccount) return null;
    if (!this.signedBy(this.config.secretKey, text, payment)) return null;
    const normalised = this.normalise(payment);
    if (normalised === null) return null;
    if (normalised.amount <= 0) return null;
    return {
      // Signed fields only: the same status delivered twice is one message, a different status or
      // reason code is another. There is no event id and no signed timestamp.
      messageKey: [
        payment.orderReference,
        payment.currency,
        payment.transactionStatus,
        asSigned(payment.reasonCode),
        payment.authCode ?? '',
        asSigned(payment.amount),
      ].join('|'),
      externalId: payment.orderReference,
      localReference: payment.orderReference,
      eventType: `transaction.${payment.transactionStatus}`,
      status: normalised.status,
      amount: normalised.amount,
      capturedAmount: normalised.capturedAmount,
      currency: normalised.currency,
      stateVersion: null,
      failureReason: failureTextOf(payment.reasonCode, payment.transactionStatus),
      // Signed fields only, without card data: the masked PAN and the auth code are dropped.
      rawPayload: {
        orderReference: payment.orderReference,
        amount: payment.amount,
        currency: payment.currency,
        transactionStatus: payment.transactionStatus,
        reasonCode: payment.reasonCode,
      },
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    assertPositiveMoney(request.amount);
    const { merchantAccount, secretKey } = this.config;
    const amount = toWayForPayAmount(request.amount);
    let response: Response;
    try {
      response = await this.post({
        transactionType: 'REFUND',
        merchantAccount,
        orderReference: request.externalId,
        amount,
        currency: 'UAH',
        // WayForPay has no refund idempotency key: our reference rides in the comment so a human
        // can match the operation. A repeat call is therefore never made after a timeout.
        comment: request.localReference,
        merchantSignature: hmacMd5(secretKey, [
          merchantAccount,
          request.externalId,
          String(amount),
          'UAH',
        ]),
      });
    } catch {
      return { state: 'unknown', error: 'timeout or network error: result unknown' };
    }
    if (!response.ok) {
      return { state: 'unknown', error: `WayForPay answered ${String(response.status)}` };
    }
    let body: unknown;
    try {
      body = await readJsonCapped(response);
    } catch {
      return { state: 'unknown', error: 'unreadable refund response' };
    }
    if (typeof body !== 'object' || body === null) {
      return { state: 'unknown', error: 'unreadable refund response' };
    }
    const status = 'transactionStatus' in body ? String(body.transactionStatus) : '';
    const reasonCode = 'reasonCode' in body ? String(body.reasonCode) : '';
    const signature =
      'merchantSignature' in body && typeof body.merchantSignature === 'string'
        ? body.merchantSignature
        : null;
    const reference = 'orderReference' in body ? String(body.orderReference) : '';
    const account = 'merchantAccount' in body ? String(body.merchantAccount) : '';
    // An answer that does not verify must not settle money either way.
    if (
      account !== merchantAccount ||
      reference !== request.externalId ||
      !signatureMatches(secretKey, [account, reference, status, reasonCode], signature)
    ) {
      return { state: 'unknown', error: 'refund answer did not verify' };
    }
    if (status === 'Refunded' || status === 'Voided') {
      return { state: 'succeeded', providerReference: null };
    }
    if (status === 'RefundInProcessing') return { state: 'in_flight', providerReference: null };
    if (status === 'Declined') return { state: 'failed', error: 'WayForPay declined the refund' };
    return { state: 'unknown', error: 'unrecognised refund status' };
  }

  /**
   * The answer WayForPay requires: `accept` with a signature over `orderReference;status;time`.
   * Without it the callback is retried for days, so the duplicate branch builds it too.
   */
  buildWebhookResponse(result: WebhookResult | { duplicate: true; of: WebhookResult }): Response {
    const reference = 'duplicate' in result ? result.of.localReference : result.localReference;
    const time = (this.config.now ?? (() => Math.floor(Date.now() / 1000)))();
    const status = 'accept';
    const body = {
      orderReference: reference,
      status,
      time,
      signature: hmacMd5(this.config.secretKey, [reference, status, String(time)]),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
