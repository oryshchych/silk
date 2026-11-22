/**
 * Mono acquiring adapter. Written from the public API description; not yet
 * run against the real sandbox (needs the owner's token, see OWNER_QUEUE).
 * Tests use a faithful fake server that signs webhooks with a real EC key.
 *
 * Mono looks invoices up by `invoiceId`, not by our reference, so a lost
 * createPayment answer cannot be recovered by asking Mono: it is reported as
 * `externalIdUnknown` and resolved through the webhook, which carries our
 * reference.
 */
import { createPublicKey } from 'node:crypto';

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
import { verifyMonoSignature } from './signature.ts';
import {
  MONO_CURRENCY_UAH,
  capturedAmountOf,
  mapMonoStatus,
  monoInvoiceSchema,
  stateVersionOf,
} from './status.ts';

export interface MonoConfig {
  /** https://api.monobank.ua in production. Plain http is accepted for loopback only. */
  baseUrl: string;
  /** X-Token. Server-only secret. */
  token: string;
  /** Per-request timeout; a timeout on a write call means "unknown", not "failed". */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** After a failed or first key fetch we wait this long before trying again. */
const KEY_RETRY_COOLDOWN_MS = 30 * 1000;
/** A key we already hold is refetched at most this often (rotation check). */
const KEY_ROTATION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Only these 4xx answers mean "the provider looked at the request and said no".
 * 408, 409, 425, 429 and every 5xx can hide an executed write (a proxy timeout,
 * a duplicate reference that already succeeded), so they stay unknown.
 */
const DEFINITE_REFUSAL = new Set([400, 401, 403, 404, 422]);

const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost';

function assertPositiveMoney(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError('payment amounts must be positive whole kopiykas');
  }
}

export class MonoProvider implements PaymentProvider {
  readonly code = 'mono';

  private readonly config: MonoConfig;
  private readonly http: typeof fetch;
  private keyPem: string | null = null;
  private lastKeyAttemptAt = 0;
  private keyInFlight: Promise<void> | null = null;

  constructor(config: MonoConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
      throw new Error('Mono base URL must be https: the X-Token travels in every request');
    }
    this.config = config;
    this.http = config.fetch ?? fetch;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    return await this.http(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: { 'X-Token': this.config.token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    });
  }

  async createPayment(attempt: PaymentAttemptRef): Promise<CreatePaymentResult> {
    assertPositiveMoney(attempt.amount);
    let response: Response;
    try {
      response = await this.call('/api/merchant/invoice/create', {
        method: 'POST',
        body: JSON.stringify({
          amount: attempt.amount,
          ccy: MONO_CURRENCY_UAH,
          merchantPaymInfo: { reference: attempt.localReference, destination: attempt.description },
          redirectUrl: attempt.redirectUrl,
          webHookUrl: attempt.webhookUrl,
          validity: attempt.validitySeconds,
        }),
      });
    } catch {
      return { ok: false, externalIdUnknown: true };
    }
    if (DEFINITE_REFUSAL.has(response.status)) {
      throw new PaymentProviderError('Mono rejected the invoice', response.status);
    }
    if (!response.ok) return { ok: false, externalIdUnknown: true };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, externalIdUnknown: true };
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      !('invoiceId' in body) ||
      !('pageUrl' in body) ||
      typeof body.invoiceId !== 'string' ||
      typeof body.pageUrl !== 'string'
    ) {
      return { ok: false, externalIdUnknown: true };
    }
    return { ok: true, redirectUrl: body.pageUrl, externalId: body.invoiceId };
  }

  async getPaymentStatus(externalId: string): Promise<PaymentStatusResult> {
    const response = await this.call(
      `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(externalId)}`,
      { method: 'GET' },
    );
    if (!response.ok) {
      throw new PaymentProviderError('Mono status lookup failed', response.status);
    }
    const invoice = monoInvoiceSchema.parse(await response.json());
    if (invoice.invoiceId !== externalId) {
      throw new PaymentProviderError('Mono answered for a different invoice', 502);
    }
    const status = mapMonoStatus(invoice.status);
    const captured = capturedAmountOf(invoice, status);
    if (captured === null)
      throw new PaymentProviderError('Mono reported an inconsistent capture', 502);
    return {
      externalId: invoice.invoiceId,
      localReference: invoice.reference ?? null,
      currency: invoice.ccy === MONO_CURRENCY_UAH ? 'UAH' : String(invoice.ccy),
      status,
      amount: money(invoice.amount),
      capturedAmount: captured,
      stateVersion: stateVersionOf(invoice),
      failureReason: invoice.failureReason ?? null,
    };
  }

  /**
   * Key cache with a bounded refetch: one request in flight at a time, a
   * cooldown counted from the ATTEMPT (so an outage cannot be amplified by
   * garbage webhooks), and a new key replaces the old one only if it parses as
   * an EC public key. Returns true when the held key changed.
   */
  private async refreshKey(): Promise<boolean> {
    const now = Date.now();
    const cooldown = this.keyPem === null ? KEY_RETRY_COOLDOWN_MS : KEY_ROTATION_COOLDOWN_MS;
    if (this.keyInFlight === null && now - this.lastKeyAttemptAt >= cooldown) {
      this.lastKeyAttemptAt = now;
      const before = this.keyPem;
      this.keyInFlight = this.fetchKey().finally(() => {
        this.keyInFlight = null;
      });
      await this.keyInFlight;
      return this.keyPem !== before;
    }
    const pending = this.keyInFlight;
    if (pending === null) return false;
    const before = this.keyPem;
    await pending;
    return this.keyPem !== before;
  }

  private async fetchKey(): Promise<void> {
    try {
      const response = await this.call('/api/merchant/pubkey', { method: 'GET' });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || !('key' in body)) return;
      if (typeof body.key !== 'string') return;
      const pem = Buffer.from(body.key, 'base64').toString('utf8');
      if (createPublicKey(pem).asymmetricKeyType !== 'ec') return;
      this.keyPem = pem;
    } catch {
      // keep whatever key we had
    }
  }

  async verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<WebhookResult | null> {
    const signature = headers.get('x-sign');
    if (this.keyPem === null) await this.refreshKey();
    let valid = verifyMonoSignature(rawBody, signature, this.keyPem);
    // The merchant key may have been rotated: a rate-limited refetch, and only
    // a different key is worth a second check.
    if (!valid && (await this.refreshKey())) {
      valid = verifyMonoSignature(rawBody, signature, this.keyPem);
    }
    if (!valid) return null;

    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    } catch {
      return null;
    }
    const parsed = monoInvoiceSchema.safeParse(json);
    if (!parsed.success) return null;
    const invoice = parsed.data;
    const status = mapMonoStatus(invoice.status);
    const captured = capturedAmountOf(invoice, status);
    const stateVersion = stateVersionOf(invoice);
    // A message that cannot be bound to an attempt, ordered, or trusted for its amounts
    // must not change financial state.
    if (invoice.reference === undefined || invoice.reference === '') return null;
    if (stateVersion === null || captured === null) return null;

    return {
      // Authenticated fields only. The date and final amount keep two distinct signed
      // messages of the same status (e.g. a changed capture) from colliding.
      messageKey: [
        invoice.invoiceId,
        invoice.status,
        invoice.modifiedDate ?? '',
        String(invoice.finalAmount ?? ''),
      ].join('|'),
      externalId: invoice.invoiceId,
      localReference: invoice.reference,
      eventType: `invoice.${invoice.status}`,
      status,
      amount: money(invoice.amount),
      capturedAmount: captured,
      currency: invoice.ccy === MONO_CURRENCY_UAH ? 'UAH' : String(invoice.ccy),
      stateVersion,
      failureReason: invoice.failureReason ?? null,
      // The validated subset only: the raw body may carry card data we must not store.
      rawPayload: invoice,
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    assertPositiveMoney(request.amount);
    let response: Response;
    try {
      response = await this.call('/api/merchant/invoice/cancel', {
        method: 'POST',
        body: JSON.stringify({
          invoiceId: request.externalId,
          extRef: request.localReference,
          amount: request.amount,
        }),
      });
    } catch {
      return { state: 'unknown', error: 'timeout or network error: result unknown' };
    }
    if (DEFINITE_REFUSAL.has(response.status)) {
      return { state: 'failed', error: `Mono refused the refund (${String(response.status)})` };
    }
    if (!response.ok)
      return { state: 'unknown', error: `Mono answered ${String(response.status)}` };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { state: 'unknown', error: 'unreadable refund response' };
    }
    const status =
      typeof body === 'object' && body !== null && 'status' in body ? body.status : undefined;
    // Mono returns no refund id of its own: the reference is ours, so none is claimed here.
    if (status === 'success') return { state: 'succeeded', providerReference: null };
    if (status === 'processing') return { state: 'in_flight', providerReference: null };
    if (status === 'failure') return { state: 'failed', error: 'Mono reported failure' };
    return { state: 'unknown', error: 'unrecognised refund status' };
  }

  buildWebhookResponse(): Response {
    // Mono only needs a 200; a duplicate gets the same answer so it stops retrying.
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}
