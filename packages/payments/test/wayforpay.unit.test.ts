import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { money } from '@store/shared/money';

import { WayForPayProvider } from '../src/wayforpay/wayforpay-provider.ts';
import {
  fromWayForPayAmount,
  hmacMd5,
  signatureMatches,
  toWayForPayAmount,
} from '../src/wayforpay/signature.ts';
import { PaymentProviderError, type PaymentAttemptRef } from '../src/types.ts';
import {
  FAKE_ACCOUNT,
  FAKE_SECRET,
  startFakeWayForPay,
  type FakeWayForPay,
} from './fake-wayforpay.ts';

let fake: FakeWayForPay;
let wfp: WayForPayProvider;

beforeAll(async () => {
  fake = await startFakeWayForPay();
  wfp = new WayForPayProvider({
    pageHosts: ['secure.example'],
    baseUrl: fake.baseUrl,
    merchantAccount: FAKE_ACCOUNT,
    secretKey: FAKE_SECRET,
    merchantDomainName: 'shop.example',
    timeoutMs: 400,
    now: () => 1_700_000_000,
  });
});
afterAll(async () => {
  await fake.close();
});

const REF = '0192f3a0-aaaa-7000-8000-000000000001';
const attempt: PaymentAttemptRef = {
  localReference: REF,
  amount: money(129910),
  currency: 'UAH',
  description: 'Order LS-2026-000001',
  redirectUrl: 'https://shop.example/order/success',
  webhookUrl: 'https://shop.example/api/webhooks/wayforpay',
  validitySeconds: 1800,
};
const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');

describe('amounts: decimal UAH by string handling only', () => {
  it('converts kopiykas both ways without a float', () => {
    expect(toWayForPayAmount(money(129910))).toBe(1299.1);
    expect(toWayForPayAmount(money(5))).toBe(0.05);
    expect(toWayForPayAmount(money(100))).toBe(1);
    expect(fromWayForPayAmount(1299.1)).toBe(129910);
    expect(fromWayForPayAmount('1299.10')).toBe(129910);
    expect(fromWayForPayAmount(0.05)).toBe(5);
    expect(fromWayForPayAmount(7)).toBe(700);
    for (const bad of ['-1', '1.234', 'abc', '1e3', '', '99999999999']) {
      expect(fromWayForPayAmount(bad), bad).toBeNull();
    }
    expect(fromWayForPayAmount(1e21)).toBeNull();
  });
});

describe('createPayment', () => {
  it('creates a signed invoice and returns the page; the external id is our reference', async () => {
    const result = await wfp.createPayment(attempt);
    expect(result).toEqual({
      ok: true,
      redirectUrl: `https://secure.example/invoice/${REF}`,
      externalId: REF,
    });
    const sent = fake.requests.at(-1)?.body;
    expect(sent).toMatchObject({ transactionType: 'CREATE_INVOICE', amount: 1299.1 });
    // The secret never travels.
    expect(JSON.stringify(sent)).not.toContain(FAKE_SECRET);
  });

  it('a logical refusal is a provider error, not an unknown result', async () => {
    fake.onCreate(() => ({ status: 200, json: { reason: 'Declined', reasonCode: 1101 } }));
    await expect(wfp.createPayment(attempt)).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('a 502, a timeout and a garbled answer are unknown (reconcile by reference), never a second invoice', async () => {
    fake.onCreate(() => ({ status: 502 }));
    expect(await wfp.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
    fake.onCreate(() => ({ status: 200, hang: true }));
    expect(await wfp.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
    fake.onCreate(() => ({ status: 200, json: { nonsense: true } }));
    expect(await wfp.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
  });

  it('refuses a non-positive amount before any call', async () => {
    const before = fake.requests.length;
    await expect(wfp.createPayment({ ...attempt, amount: money(0) })).rejects.toThrow(RangeError);
    expect(fake.requests.length).toBe(before);
  });
});

describe('verifyWebhook: HMAC_MD5 over the signed field list, fail closed', () => {
  const cb = (over: Partial<Parameters<FakeWayForPay['callback']>[0]> = {}): string =>
    fake.callback({ orderReference: REF, amount: 1299.1, transactionStatus: 'Approved', ...over });

  it('accepts a correctly signed approval', async () => {
    const result = await wfp.verifyWebhook(bytes(cb()));
    expect(result).toMatchObject({
      externalId: REF,
      localReference: REF,
      status: 'paid',
      amount: 129910,
      capturedAmount: 129910,
      currency: 'UAH',
      stateVersion: null,
    });
  });

  it('accepts the amount as a numeric string if that is what was signed', async () => {
    const result = await wfp.verifyWebhook(bytes(cb({ amount: '1299.10' })));
    expect(result?.amount).toBe(129910);
  });

  it('rejects a wrong secret, another merchant and a tampered signed field', async () => {
    expect(await wfp.verifyWebhook(bytes(cb({ secret: 'other' })))).toBeNull();
    expect(await wfp.verifyWebhook(bytes(cb({ account: 'someone_else' })))).toBeNull();
    const tampered = cb().replace('"Approved"', '"Declined"');
    expect(await wfp.verifyWebhook(bytes(tampered))).toBeNull();
    const cheaper = cb().replace('1299.1', '1.1');
    expect(await wfp.verifyWebhook(bytes(cheaper))).toBeNull();
  });

  it('unsigned fields (dates, fee) are not authenticated and change nothing', async () => {
    const a = await wfp.verifyWebhook(bytes(cb()));
    const b = await wfp.verifyWebhook(
      bytes(cb({ extra: { processingDate: 1, fee: 99, createdDate: 5 } })),
    );
    expect(b?.messageKey).toBe(a?.messageKey);
    expect(b?.status).toBe(a?.status);
  });

  it('is not fooled by garbage, missing fields or a missing signature', async () => {
    for (const raw of ['', 'nope', '[]', '{}', JSON.stringify({ orderReference: REF })]) {
      expect(await wfp.verifyWebhook(bytes(raw)), raw).toBeNull();
    }
    const noSig = JSON.parse(cb()) as Record<string, unknown>;
    delete noSig['merchantSignature'];
    expect(await wfp.verifyWebhook(bytes(JSON.stringify(noSig)))).toBeNull();
  });

  it('a zero or malformed amount is refused even when signed', async () => {
    expect(await wfp.verifyWebhook(bytes(cb({ amount: 0 })))).toBeNull();
    expect(await wfp.verifyWebhook(bytes(cb({ amount: '12.345' })))).toBeNull();
  });

  it('maps the documented statuses and never reads an unknown one as paid', async () => {
    const status = async (transactionStatus: string) =>
      (await wfp.verifyWebhook(bytes(cb({ transactionStatus }))))?.status;
    expect(await status('Declined')).toBe('failed');
    expect(await status('Expired')).toBe('expired');
    expect(await status('WaitingAuthComplete')).toBe('authorized');
    expect(await status('Refunded')).toBe('refunded');
    expect(await status('Voided')).toBe('refunded');
    expect(await status('InProcessing')).toBe('pending');
    expect(await status('SomethingNew')).toBe('pending');
  });

  it('a refunded payment reports no capture, and the dedup key differs per status', async () => {
    const refunded = await wfp.verifyWebhook(bytes(cb({ transactionStatus: 'Refunded' })));
    const paid = await wfp.verifyWebhook(bytes(cb()));
    expect(refunded?.capturedAmount).toBe(0);
    expect(refunded?.messageKey).not.toBe(paid?.messageKey);
  });

  it('stores the signed subset only: no card number', async () => {
    const result = await wfp.verifyWebhook(bytes(cb({ cardPan: '41****1111' })));
    expect(JSON.stringify(result?.rawPayload)).not.toContain('41****1111');
    expect(JSON.stringify(result?.rawPayload)).not.toContain('cardPan');
  });
});

describe('buildWebhookResponse: the signed accept, for fresh messages and duplicates', () => {
  it('signs orderReference;status;time with the secret', async () => {
    const result = await wfp.verifyWebhook(
      bytes(fake.callback({ orderReference: REF, amount: 1299.1, transactionStatus: 'Approved' })),
    );
    if (result === null) throw new Error('expected a verified message');
    for (const response of [
      wfp.buildWebhookResponse(result),
      wfp.buildWebhookResponse({ duplicate: true, of: result }),
    ]) {
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ orderReference: REF, status: 'accept', time: 1_700_000_000 });
      expect(body['signature']).toBe(hmacMd5(FAKE_SECRET, [REF, 'accept', '1700000000']));
    }
  });
});

describe('getPaymentStatus', () => {
  it('reads and verifies a signed CHECK_STATUS answer', async () => {
    fake.payments.set(REF, { amount: 1299.1, status: 'Approved', reasonCode: 1100 });
    const status = await wfp.getPaymentStatus(REF);
    expect(status).toMatchObject({ status: 'paid', amount: 129910, capturedAmount: 129910 });
  });

  it('an unknown order is a definite 404, not a transport failure', async () => {
    await expect(
      wfp.getPaymentStatus('0192f3a0-ffff-7000-8000-000000000009'),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a lookup that fails is a provider error (never a verdict on the payment)', async () => {
    const dead = new WayForPayProvider({
      pageHosts: ['secure.example'],
      baseUrl: 'http://127.0.0.1:1',
      merchantAccount: FAKE_ACCOUNT,
      secretKey: FAKE_SECRET,
      merchantDomainName: 'shop.example',
      timeoutMs: 200,
    });
    await expect(dead.getPaymentStatus(REF)).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('an answer signed with another secret is refused', async () => {
    const other = new WayForPayProvider({
      pageHosts: ['secure.example'],
      baseUrl: fake.baseUrl,
      merchantAccount: FAKE_ACCOUNT,
      secretKey: 'a-different-secret',
      merchantDomainName: 'shop.example',
    });
    // The fake rejects the request signature; either way no status is invented.
    await expect(other.getPaymentStatus(REF)).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe('refund', () => {
  const request = { localReference: 'refund-ref-1', externalId: REF, amount: money(50000) };

  it('maps Refunded, RefundInProcessing and Declined, sending our reference as the comment', async () => {
    expect(await wfp.refund(request)).toEqual({ state: 'succeeded', providerReference: null });
    expect(fake.requests.at(-1)?.body).toMatchObject({ comment: 'refund-ref-1', amount: 500 });
    const answer = (transactionStatus: string) => {
      fake.onRefund(() => ({
        status: 200,
        json: {
          merchantAccount: FAKE_ACCOUNT,
          orderReference: REF,
          transactionStatus,
          reason: 'x',
          reasonCode: 1100,
          merchantSignature: hmacMd5(FAKE_SECRET, [FAKE_ACCOUNT, REF, transactionStatus, '1100']),
        },
      }));
    };
    answer('RefundInProcessing');
    expect(await wfp.refund(request)).toEqual({ state: 'in_flight', providerReference: null });
    answer('Declined');
    expect(await wfp.refund(request)).toMatchObject({ state: 'failed' });
  });

  it('a timeout, a 5xx and an unverifiable answer are unknown, never success', async () => {
    fake.onRefund(() => ({ status: 200, hang: true }));
    expect(await wfp.refund(request)).toMatchObject({ state: 'unknown' });
    fake.onRefund(() => ({ status: 503 }));
    expect(await wfp.refund(request)).toMatchObject({ state: 'unknown' });
    fake.onRefund(() => ({
      status: 200,
      json: {
        merchantAccount: FAKE_ACCOUNT,
        orderReference: REF,
        transactionStatus: 'Refunded',
        reasonCode: 1100,
        merchantSignature: 'forged',
      },
    }));
    expect(await wfp.refund(request)).toMatchObject({ state: 'unknown' });
  });
});

describe('configuration', () => {
  it('refuses plain http outside loopback and an empty secret', () => {
    const base = { merchantAccount: 'a', secretKey: 'b', merchantDomainName: 'c' };
    expect(() => new WayForPayProvider({ ...base, baseUrl: 'http://pay.example' })).toThrow();
    expect(
      () => new WayForPayProvider({ ...base, secretKey: '', baseUrl: 'https://x.example' }),
    ).toThrow();
  });
});

describe('review round: unsigned fields, nulls, amount text, caps', () => {
  const cb = (over: Partial<Parameters<FakeWayForPay['callback']>[0]> = {}): string =>
    fake.callback({
      orderReference: REF,
      amount: 1299.1,
      transactionStatus: 'Declined',
      reasonCode: 1101,
      ...over,
    });

  it('the unsigned `reason` never reaches the failure text: it comes from the signed reason code', async () => {
    const raw = cb({ extra: { reason: '<script>evil()</script> attacker text' } });
    const result = await wfp.verifyWebhook(bytes(raw));
    expect(result?.failureReason).toBe('WayForPay reason code 1101');
    expect(JSON.stringify(result)).not.toContain('script');
    expect(JSON.stringify(result)).not.toContain('attacker');
  });

  it('a genuine message with a JSON null in an optional signed field still verifies', async () => {
    const raw = cb()
      .replace('"authCode":""', '"authCode":null')
      .replace('"cardPan":"41****1111"', '"cardPan":null');
    expect(raw).toContain('"authCode":null');
    // Signed over empty strings for the missing values: a null is an empty value.
    const forNull = fake.callback({
      orderReference: REF,
      amount: 1299.1,
      transactionStatus: 'Declined',
      reasonCode: 1101,
      authCode: '',
      cardPan: '',
    });
    const nulled = forNull
      .replace('"authCode":""', '"authCode":null')
      .replace('"cardPan":""', '"cardPan":null');
    expect((await wfp.verifyWebhook(bytes(nulled)))?.status).toBe('failed');
  });

  it('an amount signed as written ("10.10") verifies although the parsed number prints 10.1', async () => {
    const quoted = fake.callback({
      orderReference: REF,
      amount: '10.10',
      transactionStatus: 'Approved',
    });
    const asNumber = quoted.replace('"amount":"10.10"', '"amount":10.10');
    expect(asNumber).toContain('"amount":10.10');
    expect((await wfp.verifyWebhook(bytes(asNumber)))?.amount).toBe(1010);
    expect((await wfp.verifyWebhook(bytes(quoted)))?.amount).toBe(1010);
    // The normalised text is accepted too.
    expect(
      (
        await wfp.verifyWebhook(
          bytes(
            fake.callback({ orderReference: REF, amount: 10.1, transactionStatus: 'Approved' }),
          ),
        )
      )?.amount,
    ).toBe(1010);
  });

  it('two amount keys (a duplicate-key trick) are refused even if the first one is signed', async () => {
    const genuine = fake.callback({
      orderReference: REF,
      amount: 1,
      transactionStatus: 'Approved',
    });
    const tricked = genuine.replace('{', '{"amount":999999,');
    expect(await wfp.verifyWebhook(bytes(tricked))).toBeNull();
    const trailing = genuine.replace(/}$/, ',"amount":999999}');
    expect(await wfp.verifyWebhook(bytes(trailing))).toBeNull();
  });

  it('a null or empty secret never matches, whatever the signature', () => {
    for (const secret of [null, '']) {
      expect(signatureMatches(secret, ['a'], hmacMd5('', ['a']))).toBe(false);
    }
    expect(signatureMatches('k', ['a'], null)).toBe(false);
    expect(signatureMatches('k', ['a'], hmacMd5('k', ['a']))).toBe(true);
  });

  it('the accept carries the time of the answer: a later answer has another time and signature', async () => {
    let now = 1_700_000_000;
    const clocked = new WayForPayProvider({
      pageHosts: ['secure.example'],
      baseUrl: fake.baseUrl,
      merchantAccount: FAKE_ACCOUNT,
      secretKey: FAKE_SECRET,
      merchantDomainName: 'shop.example',
      now: () => now,
    });
    const result = await clocked.verifyWebhook(
      bytes(fake.callback({ orderReference: REF, amount: 1299.1, transactionStatus: 'Approved' })),
    );
    if (result === null) throw new Error('expected a verified message');
    const first = (await clocked.buildWebhookResponse(result).json()) as Record<string, unknown>;
    now += 60;
    const second = (await clocked.buildWebhookResponse(result).json()) as Record<string, unknown>;
    expect(second['time']).toBe(1_700_000_060);
    expect(second['signature']).not.toBe(first['signature']);
    expect(second['signature']).toBe(hmacMd5(FAKE_SECRET, [REF, 'accept', '1700000060']));
  });

  it('messages that differ only in currency do not share a dedup key', async () => {
    const uah = await wfp.verifyWebhook(
      bytes(fake.callback({ orderReference: REF, amount: 5, transactionStatus: 'Approved' })),
    );
    const usd = await wfp.verifyWebhook(
      bytes(
        fake
          .callback({ orderReference: REF, amount: 5, transactionStatus: 'Approved' })
          .replace('"currency":"UAH"', '"currency":"USD"'),
      ),
    );
    // The USD message is not signed for USD, so it is refused outright (the key can never collide).
    expect(usd).toBeNull();
    expect(uah?.messageKey).toContain('UAH');
  });

  it('an oversized provider answer is an unknown result, never buffered whole; a redirect is not followed', async () => {
    fake.onCreate(() => ({
      status: 200,
      json: { reasonCode: 1100, invoiceUrl: 'x', pad: 'x'.repeat(2 * 1024 * 1024) },
    }));
    expect(await wfp.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
    fake.onCreate(() => ({ status: 307, headers: { Location: 'http://127.0.0.1:1/elsewhere' } }));
    expect(await wfp.createPayment(attempt)).toEqual({ ok: false, externalIdUnknown: true });
    fake.onCreate((body) => {
      const ref = String(body['orderReference']);
      fake.payments.set(ref, {
        amount: Number(body['amount']),
        status: 'Created',
        reasonCode: 1100,
      });
      return {
        status: 200,
        json: { reasonCode: 1100, invoiceUrl: `https://secure.example/invoice/${ref}` },
      };
    });
  });
});
