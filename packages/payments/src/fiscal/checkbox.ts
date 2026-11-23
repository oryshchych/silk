/**
 * Checkbox (api.checkbox.in.ua) adapter, written from the public API description: cashier sign-in
 * returns a bearer token, a receipt needs an OPEN SHIFT, `POST /receipts/sell` takes a client-chosen
 * receipt id (our idempotency key), goods carry kopiykas and quantity in thousandths, payments are
 * CASH or CASHLESS with a label. Not yet run against the sandbox: the account does not exist
 * (OWNER_QUEUE Q3). Facts to confirm there: the exact shape of a RETURN receipt (assumed:
 * `related_receipt_id` on /receipts/sell) and the label text for cash on delivery.
 *
 * The cashier credentials and the licence key are server-only secrets; they travel only in
 * request headers and bodies to the configured HTTPS base (plain http for loopback only).
 */
import { z } from 'zod';

import { add, money, multiply } from '@store/shared/money';

import type {
  FiscalLookup,
  FiscalProvider,
  FiscalResult,
  FiscalReturnRequest,
  FiscalSaleRequest,
} from './types.ts';

export interface CheckboxConfig {
  /** https://api.checkbox.in.ua/api/v1 in production. */
  baseUrl: string;
  /** Cash register licence key (X-License-Key). */
  licenseKey: string;
  cashierLogin: string;
  cashierPassword: string;
  timeoutMs?: number;
  /** How many times a fresh receipt is re-read waiting for its fiscal number. */
  settlePolls?: number;
  fetch?: typeof fetch;
}

const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

const receiptSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  fiscal_code: z.string().nullable().optional(),
});

const CASH_ON_DELIVERY_LABEL = 'Післяплата';
const CARD_LABEL = 'Безготівковий розрахунок';

class CheckboxRefusal extends Error {}

export class CheckboxProvider implements FiscalProvider {
  readonly code = 'checkbox';

  private readonly config: CheckboxConfig;
  private readonly http: typeof fetch;
  private token: string | null = null;

  constructor(config: CheckboxConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
      throw new Error('Checkbox base URL must be https: credentials travel in the requests');
    }
    this.config = config;
    this.http = config.fetch ?? fetch;
  }

  private async call(path: string, init: RequestInit, authed = true): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-License-Key': this.config.licenseKey,
      'X-Client-Name': 'silk-store',
      'X-Client-Version': '1',
    };
    if (authed) headers['Authorization'] = `Bearer ${this.token ?? ''}`;
    return await this.http(`${this.config.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    });
  }

  private async signIn(): Promise<void> {
    const response = await this.call(
      '/cashier/signin',
      {
        method: 'POST',
        body: JSON.stringify({
          login: this.config.cashierLogin,
          password: this.config.cashierPassword,
        }),
      },
      false,
    );
    if (!response.ok) throw new CheckboxRefusal(`sign-in refused (${String(response.status)})`);
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !('access_token' in body) ||
      typeof body.access_token !== 'string'
    ) {
      throw new CheckboxRefusal('sign-in answered without a token');
    }
    this.token = body.access_token;
  }

  /** One authenticated call; a 401 means an expired token: sign in once and repeat. */
  private async authed(path: string, init: RequestInit): Promise<Response> {
    if (this.token === null) await this.signIn();
    let response = await this.call(path, init);
    if (response.status === 401) {
      await this.signIn();
      response = await this.call(path, init);
    }
    return response;
  }

  private async ensureShift(): Promise<void> {
    const shift = await this.authed('/cashier/shift', { method: 'GET' });
    if (shift.ok) {
      const body: unknown = await shift.json();
      if (
        typeof body === 'object' &&
        body !== null &&
        'status' in body &&
        body.status === 'OPENED'
      ) {
        return;
      }
    }
    const opened = await this.authed('/shifts', { method: 'POST', body: '{}' });
    // 4xx while opening may be "already open" (a race with another process): read it again.
    if (!opened.ok && opened.status !== 400 && opened.status !== 409) {
      throw new CheckboxRefusal(`the shift could not be opened (${String(opened.status)})`);
    }
  }

  private payload(request: FiscalSaleRequest): Record<string, unknown> {
    return {
      id: request.localReference,
      goods: request.items.map((item) => ({
        good: {
          code: item.code,
          name: item.name,
          price: item.unitPrice,
          ...(item.uktzed === undefined ? {} : { uktzed: item.uktzed }),
        },
        // Checkbox counts quantity in thousandths.
        quantity: item.quantity * 1000,
      })),
      payments: [
        {
          type: 'CASHLESS',
          value: request.total,
          label: request.paymentForm === 'cash_on_delivery' ? CASH_ON_DELIVERY_LABEL : CARD_LABEL,
        },
      ],
      ...(request.buyerEmail === null ? {} : { delivery: { email: request.buyerEmail } }),
    };
  }

  private async submit(body: Record<string, unknown>): Promise<FiscalResult> {
    const id = String(body['id']);
    try {
      await this.ensureShift();
      const response = await this.authed('/receipts/sell', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (response.status === 400 || response.status === 422) {
        return {
          state: 'failed',
          error: `Checkbox refused the receipt (${String(response.status)})`,
        };
      }
      // 409: this id already exists (a repeat after a lost answer): treat as accepted and read it.
      if (!response.ok && response.status !== 409) {
        return { state: 'unknown', error: `Checkbox answered ${String(response.status)}` };
      }
    } catch (error) {
      if (error instanceof CheckboxRefusal) return { state: 'failed', error: error.message };
      return { state: 'unknown', error: 'timeout or network error: result unknown' };
    }
    return await this.settle(id);
  }

  /** Re-reads a fresh receipt a few times: the fiscal number appears when the receipt is DONE. */
  private async settle(id: string): Promise<FiscalResult> {
    const polls = this.config.settlePolls ?? 3;
    let last: FiscalResult = { state: 'in_flight', providerId: id };
    for (let i = 0; i < polls; i += 1) {
      const lookup = await this.lookup(id).catch(() => null);
      if (lookup === null) return { state: 'unknown', error: 'receipt lookup failed' };
      if (!lookup.found) return { state: 'unknown', error: 'receipt not visible after creation' };
      last = lookup.result;
      if (last.state !== 'in_flight') return last;
    }
    return last;
  }

  async lookup(localReference: string): Promise<FiscalLookup> {
    const response = await this.authed(`/receipts/${encodeURIComponent(localReference)}`, {
      method: 'GET',
    });
    if (response.status === 404) return { found: false };
    if (!response.ok) throw new Error(`Checkbox lookup answered ${String(response.status)}`);
    const parsed = receiptSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.id !== localReference) {
      throw new Error('Checkbox lookup answered for a different receipt');
    }
    const { status, fiscal_code: code } = parsed.data;
    if (status === 'ERROR') {
      return {
        found: true,
        result: { state: 'failed', error: 'Checkbox could not fiscalise the receipt' },
      };
    }
    if (status === 'DONE' && typeof code === 'string' && code !== '') {
      return {
        found: true,
        result: {
          state: 'issued',
          providerId: parsed.data.id,
          fiscalNumber: code,
          receiptUrl: `${this.receiptHost()}/${parsed.data.id}`,
        },
      };
    }
    return { found: true, result: { state: 'in_flight', providerId: parsed.data.id } };
  }

  private receiptHost(): string {
    // The public receipt page lives on its own host; derived from the API host only when it is
    // the production one, so a fake never yields a public-looking link.
    return new URL(this.config.baseUrl).hostname === 'api.checkbox.in.ua'
      ? 'https://check.checkbox.in.ua'
      : `${new URL(this.config.baseUrl).origin}/receipt-page`;
  }

  async issueSale(request: FiscalSaleRequest): Promise<FiscalResult> {
    this.assertTotal(request);
    return await this.submit(this.payload(request));
  }

  async issueReturn(request: FiscalReturnRequest): Promise<FiscalResult> {
    this.assertTotal(request);
    if (request.parentProviderId === '') throw new RangeError('a return needs its primary receipt');
    return await this.submit({
      ...this.payload(request),
      related_receipt_id: request.parentProviderId,
    });
  }

  private assertTotal(request: FiscalSaleRequest): void {
    const sum = request.items.reduce(
      (total, item) => add(total, multiply(item.unitPrice, item.quantity)),
      money(0),
    );
    if (request.items.length === 0 || sum !== request.total || request.total <= 0) {
      throw new RangeError('a receipt total must equal the sum of its items and be positive');
    }
  }
}
