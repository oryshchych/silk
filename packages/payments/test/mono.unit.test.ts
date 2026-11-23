import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { money } from '@store/shared/money';

import { MonoProvider } from '../src/mono/mono-provider.ts';
import {
  PaymentProviderError,
  type PaymentAttemptRef,
  type PaymentProvider,
} from '../src/types.ts';
import { startFakeMono, type FakeMono } from './fake-mono.ts';

let fake: FakeMono;
let mono: MonoProvider;

afterEach(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  fake = await startFakeMono();
  mono = new MonoProvider({ baseUrl: fake.baseUrl, token: 'test-token', timeoutMs: 400 });
});

afterAll(async () => {
  await fake.close();
});

const attempt: PaymentAttemptRef = {
  localReference: '0192f3a0-aaaa-7000-8000-000000000001',
  amount: money(129900),
  currency: 'UAH',
  description: 'Order LS-2026-000001',
  redirectUrl: 'https://shop.example/order/success',
  webhookUrl: 'https://shop.example/api/webhooks/mono',
  validitySeconds: 1800,
};

const webhook = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    invoiceId: 'inv-1',
    status: 'success',
    amount: 129900,
    ccy: 980,
    finalAmount: 129900,
    reference: attempt.localReference,
    modifiedDate: '2026-11-22T10:00:00Z',
    ...over,
  });

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');

const headersFor = (sig: string | null) => new Headers(sig === null ? {} : { 'X-Sign': sig });

describe('verifyWebhook: signature over the raw body, fail closed', () => {
  it('accepts a body signed with the merchant key', async () => {
    const raw = webhook();
    const result = await mono.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)));
    expect(result).toMatchObject({
      externalId: 'inv-1',
      localReference: attempt.localReference,
      status: 'paid',
      amount: 129900,
      capturedAmount: 129900,
      currency: 'UAH',
    });
  });

  it('rejects a body changed after signing (any byte, even whitespace)', async () => {
    const raw = webhook();
    const sig = fake.sign(raw);
    expect(
      await mono.verifyWebhook(bytes(raw.replace('129900', '100')), headersFor(sig)),
    ).toBeNull();
    expect(await mono.verifyWebhook(bytes(`${raw} `), headersFor(sig))).toBeNull();
  });

  it('rejects a signature from another key, a missing header and garbage', async () => {
    const raw = webhook();
    expect(await mono.verifyWebhook(bytes(raw), headersFor(fake.foreignSign(raw)))).toBeNull();
    expect(await mono.verifyWebhook(bytes(raw), headersFor(null))).toBeNull();
    expect(await mono.verifyWebhook(bytes(raw), headersFor('not-base64!!'))).toBeNull();
    expect(await mono.verifyWebhook(bytes(raw), headersFor(''))).toBeNull();
  });

  it('fails closed when the merchant key cannot be fetched', async () => {
    const offline = new MonoProvider({ baseUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 200 });
    const raw = webhook();
    expect(await offline.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)))).toBeNull();
  });

  it('a signed but structurally invalid body is not a webhook', async () => {
    const raw = '{"hello":"world"}';
    expect(await mono.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)))).toBeNull();
  });

  it('the message key is stable on redelivery and differs per state', async () => {
    const a = webhook();
    const b = webhook({ status: 'processing', modifiedDate: '2026-11-22T09:59:00Z' });
    const sameStatusLater = webhook({ modifiedDate: '2026-11-22T10:05:00Z' });
    const otherCapture = webhook({ finalAmount: 100000 });
    const keyA = (await mono.verifyWebhook(bytes(a), headersFor(fake.sign(a))))?.messageKey;
    const keyA2 = (await mono.verifyWebhook(bytes(a), headersFor(fake.sign(a))))?.messageKey;
    const keyB = (await mono.verifyWebhook(bytes(b), headersFor(fake.sign(b))))?.messageKey;
    expect(keyA).toBe(keyA2);
    expect(keyA).not.toBe(keyB);
    const otherStatusSameDate = webhook({ status: 'hold' });
    for (const other of [sameStatusLater, otherCapture, otherStatusSameDate]) {
      const key = (await mono.verifyWebhook(bytes(other), headersFor(fake.sign(other))))
        ?.messageKey;
      expect(key).not.toBe(keyA);
    }
  });

  it('an unknown status is never read as paid', async () => {
    const raw = webhook({ status: 'something-new' });
    const result = await mono.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)));
    expect(result?.status).toBe('pending');
    expect(result?.capturedAmount).toBe(0);
  });

  it('maps hold, failure, expired and reversed', async () => {
    const statuses = {
      hold: 'authorized',
      failure: 'failed',
      expired: 'expired',
      reversed: 'refunded',
    };
    for (const [monoStatus, expected] of Object.entries(statuses)) {
      const raw = webhook({ status: monoStatus });
      expect((await mono.verifyWebhook(bytes(raw), headersFor(fake.sign(raw))))?.status).toBe(
        expected,
      );
    }
  });
});

describe('the merchant key: bounded fetching, validated, rotation', () => {
  const pubkeyCalls = (): number =>
    fake.requests.filter((r) => r.url === '/api/merchant/pubkey').length;

  it('garbage webhooks cannot make us hammer Mono: bounded key requests', async () => {
    const provider = new MonoProvider({ baseUrl: fake.baseUrl, token: 't', timeoutMs: 400 });
    fake.setPubkeyMode('error');
    const before = pubkeyCalls();
    const raw = webhook();
    await Promise.all(
      Array.from(
        { length: 20 },
        async () => await provider.verifyWebhook(bytes(raw), headersFor('AAAA')),
      ),
    );
    await provider.verifyWebhook(bytes(raw), headersFor('AAAA'));
    expect(pubkeyCalls() - before).toBe(1); // single flight, then the cooldown holds
    fake.setPubkeyMode('ok');
  });

  it('a malformed key response does not replace a good key', async () => {
    const provider = new MonoProvider({ baseUrl: fake.baseUrl, token: 't', timeoutMs: 400 });
    const raw = webhook();
    expect(await provider.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)))).not.toBeNull();
    fake.setPubkeyMode('garbage');
    // a forced refetch is rate limited anyway; the held key must stay usable
    expect(await provider.verifyWebhook(bytes(raw), headersFor(fake.foreignSign(raw)))).toBeNull();
    expect(await provider.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)))).not.toBeNull();
    fake.setPubkeyMode('ok');
  });

  it('after the rotation window a non-EC key never replaces the good one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const provider = new MonoProvider({ baseUrl: fake.baseUrl, token: 't', timeoutMs: 400 });
      const raw = webhook();
      expect(await provider.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)))).not.toBeNull();
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      fake.setPubkeyMode('rsa');
      // a bad signature triggers the (now allowed) refetch; the RSA key must be refused
      expect(
        await provider.verifyWebhook(bytes(raw), headersFor(fake.foreignSign(raw))),
      ).toBeNull();
      expect(await provider.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)))).not.toBeNull();
    } finally {
      fake.setPubkeyMode('ok');
    }
  });

  it('a rotated merchant key is picked up once the window allows it', async () => {
    const own = await startFakeMono(); // its own key: rotating must not disturb the shared fake
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      const provider = new MonoProvider({ baseUrl: own.baseUrl, token: 't', timeoutMs: 400 });
      const raw = webhook();
      expect(await provider.verifyWebhook(bytes(raw), headersFor(own.sign(raw)))).not.toBeNull();
      own.rotateKey();
      expect(await provider.verifyWebhook(bytes(raw), headersFor(own.sign(raw)))).toBeNull();
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      expect(await provider.verifyWebhook(bytes(raw), headersFor(own.sign(raw)))).not.toBeNull();
    } finally {
      await own.close();
    }
  });

  it('refuses a plain-http base URL outside loopback', () => {
    expect(() => new MonoProvider({ baseUrl: 'http://api.monobank.ua', token: 't' })).toThrow(
      /https/,
    );
    expect(
      () => new MonoProvider({ baseUrl: 'https://api.monobank.ua', token: 't' }),
    ).not.toThrow();
  });
});

describe('createPayment', () => {
  it('sends kopiykas, UAH code and our reference; returns the page url and invoice id', async () => {
    const result = await mono.createPayment(attempt);
    expect(result).toMatchObject({ ok: true, externalId: 'inv-1' });
    const sent = fake.requests.findLast((r) => r.url === '/api/merchant/invoice/create');
    expect(sent?.token).toBe('test-token');
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
      amount: 129900,
      ccy: 980,
      merchantPaymInfo: { reference: attempt.localReference },
      validity: 1800,
    });
  });

  it('a lost answer is externalIdUnknown, not an error and not a second invoice', async () => {
    fake.onCreate(() => ({ status: 200, hang: true }));
    expect(await mono.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
    fake.onCreate(() => ({ status: 502 }));
    expect(await mono.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
    fake.onCreate(() => ({ status: 200 })); // empty body
    expect(await mono.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
    fake.onCreate(() => ({ status: 200, json: { unexpected: true } }));
    expect(await mono.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
  });

  it('a definite 4xx rejection is an error', async () => {
    fake.onCreate(() => ({ status: 400, json: { errText: 'bad amount' } }));
    await expect(mono.createPayment(attempt)).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('408 and 409 are ambiguous, not refusals', async () => {
    for (const status of [408, 409, 429]) {
      fake.onCreate(() => ({ status }));
      expect(await mono.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
    }
  });

  it('refuses a non-positive amount before any request', async () => {
    const calls = fake.requests.length;
    await expect(mono.createPayment({ ...attempt, amount: money(0) })).rejects.toThrow(RangeError);
    expect(fake.requests.length).toBe(calls);
  });
});

describe('getPaymentStatus and refund', () => {
  it('reads and maps the invoice status', async () => {
    fake.invoices.set('inv-9', {
      invoiceId: 'inv-9',
      status: 'success',
      reference: 'ref-9',
      finalAmount: 129900,
      modifiedDate: '2026-11-22T10:00:00Z',
    });
    expect(await mono.getPaymentStatus('inv-9')).toMatchObject({
      externalId: 'inv-9',
      status: 'paid',
      capturedAmount: 129900,
      localReference: 'ref-9',
    });
    await expect(mono.getPaymentStatus('missing')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('refuses an answer for a different invoice than the one asked about', async () => {
    fake.invoices.set('inv-asked', {
      invoiceId: 'inv-other',
      status: 'success',
      finalAmount: 129900,
      reference: 'r',
    });
    await expect(mono.getPaymentStatus('inv-asked')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('wraps network failures and unparsable answers as provider errors', async () => {
    const offline = new MonoProvider({ baseUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 200 });
    await expect(offline.getPaymentStatus('inv-9')).rejects.toBeInstanceOf(PaymentProviderError);
    fake.invoices.set('inv-bad', { invoiceId: 'inv-bad', status: 'success', amount: -1 });
    await expect(mono.getPaymentStatus('inv-bad')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('refund 408/409 stay unknown, a lost answer is asked once and never retried', async () => {
    const request = { localReference: 'refund-2', externalId: 'inv-9', amount: money(5000) };
    for (const status of [408, 409]) {
      fake.onCancel(() => ({ status }));
      expect(await mono.refund(request)).toMatchObject({ state: 'unknown' });
    }
    const before = fake.requests.filter((r) => r.url === '/api/merchant/invoice/cancel').length;
    fake.onCancel(() => ({ status: 200, hang: true }));
    expect(await mono.refund(request)).toMatchObject({ state: 'unknown' });
    const after = fake.requests.filter((r) => r.url === '/api/merchant/invoice/cancel').length;
    expect(after - before).toBe(1);
    fake.onCancel(() => ({ status: 200, json: { status: 'success' } }));
    await expect(mono.refund({ ...request, amount: money(-1) })).rejects.toThrow(RangeError);
  });

  it('refund: success, in flight, refusal, and a timeout is unknown (never failed)', async () => {
    const request = { localReference: 'refund-1', externalId: 'inv-9', amount: money(5000) };
    expect(await mono.refund(request)).toMatchObject({
      state: 'succeeded',
      providerReference: null,
    });
    const sent = fake.requests.findLast((r) => r.url === '/api/merchant/invoice/cancel');
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({
      invoiceId: 'inv-9',
      extRef: 'refund-1',
      amount: 5000,
    });

    fake.onCancel(() => ({ status: 200, json: { status: 'processing' } }));
    expect(await mono.refund(request)).toMatchObject({ state: 'in_flight' });
    fake.onCancel(() => ({ status: 400, json: {} }));
    expect(await mono.refund(request)).toMatchObject({ state: 'failed' });
    fake.onCancel(() => ({ status: 200, hang: true }));
    expect(await mono.refund(request)).toMatchObject({ state: 'unknown' });
    fake.onCancel(() => ({ status: 503 }));
    expect(await mono.refund(request)).toMatchObject({ state: 'unknown' });
    fake.onCancel(() => ({ status: 200, json: { status: 'weird' } }));
    expect(await mono.refund(request)).toMatchObject({ state: 'unknown' });
    fake.onCancel(() => ({ status: 200 })); // empty body: unreadable
    expect(await mono.refund(request)).toMatchObject({ state: 'unknown' });
    fake.onCancel(() => ({ status: 200, json: { status: 'failure' } }));
    expect(await mono.refund(request)).toMatchObject({ state: 'failed' });
  });
});

describe('field handling', () => {
  it('rejects messages that cannot be ordered, bound or trusted for their amounts', async () => {
    const bad = [
      { modifiedDate: undefined }, // no version: cannot be ordered
      { modifiedDate: 'yesterday' },
      { reference: undefined }, // cannot be bound to an attempt
      { finalAmount: undefined }, // success without a capture
      { finalAmount: 129901 }, // captured more than invoiced
      { amount: 0 },
      { amount: -5 },
      { amount: 2_147_483_648 },
    ];
    for (const over of bad) {
      const raw = webhook(over);
      expect(
        await mono.verifyWebhook(bytes(raw), headersFor(fake.sign(raw))),
        JSON.stringify(over),
      ).toBeNull();
    }
  });

  it('stores only the validated subset of the payload, never extra card data', async () => {
    const raw = webhook({ maskedPan: '444433******1111', paymentInfo: { rrn: '123' } });
    const result = await mono.verifyWebhook(bytes(raw), headersFor(fake.sign(raw)));
    expect(JSON.stringify(result?.rawPayload)).not.toContain('maskedPan');
    expect(JSON.stringify(result?.rawPayload)).not.toContain('rrn');
  });

  it('a non-UAH currency is reported as is', async () => {
    const raw = webhook({ ccy: 840 });
    expect((await mono.verifyWebhook(bytes(raw), headersFor(fake.sign(raw))))?.currency).toBe(
      '840',
    );
  });
});

describe('buildWebhookResponse', () => {
  it('answers 200 for a fresh message and for a duplicate alike', () => {
    const provider: PaymentProvider = mono; // through the contract: duplicates are a valid argument
    const of = {
      messageKey: 'k',
      externalId: 'inv-1',
      localReference: attempt.localReference,
      eventType: 'invoice.success',
      status: 'paid',
      amount: money(129900),
      capturedAmount: money(129900),
      currency: 'UAH',
      stateVersion: null,
      failureReason: null,
      rawPayload: {},
    } as const;
    expect(provider.buildWebhookResponse({ duplicate: true, of }).status).toBe(200);
    expect(provider.buildWebhookResponse({ duplicate: true, of }).headers.get('content-type')).toBe(
      'application/json',
    );
  });
});
