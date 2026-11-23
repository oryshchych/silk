import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { money } from '@store/shared/money';

import { CheckboxProvider } from '../src/fiscal/checkbox.ts';
import type { FiscalSaleRequest } from '../src/fiscal/types.ts';
import {
  FAKE_LICENSE,
  FAKE_LOGIN,
  FAKE_PASSWORD,
  startFakeCheckbox,
  type FakeCheckbox,
} from './fake-checkbox.ts';

let fake: FakeCheckbox;
const make = (over: Partial<ConstructorParameters<typeof CheckboxProvider>[0]> = {}) =>
  new CheckboxProvider({
    baseUrl: fake.baseUrl,
    licenseKey: FAKE_LICENSE,
    cashierLogin: FAKE_LOGIN,
    cashierPassword: FAKE_PASSWORD,
    timeoutMs: 400,
    ...over,
  });

beforeAll(async () => {
  fake = await startFakeCheckbox();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.receipts.clear();
  fake.settleAfterReads.value = 0;
  fake.failNextSell(null);
});

let n = 0;
const sale = (over: Partial<FiscalSaleRequest> = {}): FiscalSaleRequest => {
  n += 1;
  return {
    localReference: `0192f3a0-bbbb-7000-8000-${String(n).padStart(12, '0')}`,
    items: [
      { code: 'SKU-1', name: 'Bra', unitPrice: money(129900), quantity: 1 },
      { code: 'SKU-2', name: 'Briefs', unitPrice: money(35000), quantity: 2 },
    ],
    total: money(199900),
    paymentForm: 'card',
    buyerEmail: 'buyer@example.com',
    ...over,
  };
};

describe('issueSale', () => {
  it('signs in, opens the shift, creates the receipt under OUR id and returns the fiscal number', async () => {
    const provider = make();
    const request = sale();
    const result = await provider.issueSale(request);
    expect(result).toMatchObject({ state: 'issued', providerId: request.localReference });
    expect(result.state === 'issued' && result.fiscalNumber).toMatch(/^FN/);
    const stored = fake.receipts.get(request.localReference)?.body;
    // Quantity in thousandths, kopiykas prices, the card label.
    expect(JSON.stringify(stored)).toContain('"quantity":2000');
    expect(stored).toMatchObject({ payments: [{ type: 'CASHLESS', value: 199900 }] });
  });

  it('cash on delivery is sent with the "Післяплата" payment form', async () => {
    const request = sale({ paymentForm: 'cash_on_delivery' });
    await make().issueSale(request);
    expect(JSON.stringify(fake.receipts.get(request.localReference)?.body)).toContain('Післяплата');
  });

  it('an expired token is renewed once and the call repeated', async () => {
    const provider = make();
    await provider.issueSale(sale());
    const before = fake.state.signIns;
    fake.expireToken();
    expect((await provider.issueSale(sale())).state).toBe('issued');
    expect(fake.state.signIns).toBe(before + 1);
  });

  it('a receipt that is not DONE yet is in_flight and resolves by lookup', async () => {
    fake.settleAfterReads.value = 99;
    const provider = make({ settlePolls: 2 });
    const request = sale();
    const first = await provider.issueSale(request);
    expect(first).toEqual({ state: 'in_flight', providerId: request.localReference });
    fake.settleAfterReads.value = 0;
    const lookup = await provider.lookup(request.localReference);
    expect(lookup).toMatchObject({ found: true, result: { state: 'issued' } });
  });

  it('a validation refusal is failed; wrong credentials are failed, not a retry loop', async () => {
    fake.failNextSell({ status: 422 });
    expect((await make().issueSale(sale())).state).toBe('failed');
    const wrong = make({ cashierPassword: 'nope' });
    expect(await wrong.issueSale(sale())).toMatchObject({ state: 'failed' });
  });

  it('ADR-16: a 503 and a timeout are unknown, and a repeat after a lost answer makes no second receipt', async () => {
    const provider = make();
    const request = sale();
    fake.failNextSell({ status: 503 });
    expect((await provider.issueSale(request)).state).toBe('unknown');
    expect(fake.receipts.size).toBe(0);

    // The answer was lost but the receipt exists: the retry hits 409 and reads the SAME receipt.
    const lost = sale();
    fake.failNextSell({ status: 200, hang: true, store: true });
    expect((await provider.issueSale(lost)).state).toBe('unknown');
    expect(await provider.lookup(lost.localReference)).toMatchObject({ found: true });
    const again = await provider.issueSale(lost);
    expect(again).toMatchObject({ state: 'issued', providerId: lost.localReference });
    expect([...fake.receipts.keys()].filter((id) => id === lost.localReference)).toHaveLength(1);
  });

  it('refuses a total that is not the sum of the items before any call', async () => {
    const before = fake.state.signIns;
    await expect(make().issueSale(sale({ total: money(1) }))).rejects.toThrow(RangeError);
    await expect(make().issueSale(sale({ items: [], total: money(0) }))).rejects.toThrow(
      RangeError,
    );
    expect(fake.state.signIns).toBe(before);
  });
});

describe('issueReturn', () => {
  it('points at the primary receipt and carries it', async () => {
    const provider = make();
    const primary = sale();
    const issued = await provider.issueSale(primary);
    if (issued.state !== 'issued') throw new Error('expected an issued sale');
    const ret = sale({
      items: [{ code: 'SKU-1', name: 'Bra', unitPrice: money(129900), quantity: 1 }],
      total: money(129900),
    });
    const result = await provider.issueReturn({
      ...ret,
      parentProviderId: issued.providerId,
      parentFiscalNumber: issued.fiscalNumber,
    });
    expect(result.state).toBe('issued');
    expect(fake.receipts.get(ret.localReference)?.body).toMatchObject({
      related_receipt_id: primary.localReference,
    });
  });

  it('refuses a return without a primary receipt', async () => {
    await expect(
      make().issueReturn({ ...sale(), parentProviderId: '', parentFiscalNumber: '' }),
    ).rejects.toThrow(RangeError);
  });
});

describe('lookup and configuration', () => {
  it('an unknown reference is not found (safe to send)', async () => {
    expect(await make().lookup('0192f3a0-0000-7000-8000-00000000dead')).toEqual({ found: false });
  });

  it('refuses plain http outside loopback', () => {
    expect(
      () =>
        new CheckboxProvider({
          baseUrl: 'http://api.example',
          licenseKey: 'k',
          cashierLogin: 'l',
          cashierPassword: 'p',
        }),
    ).toThrow();
  });
});

describe('review round: transient failures are retryable (ADR-16), redirects are not followed', () => {
  it('a 503 or 429 on sign-in is unknown, not failed; 403 is definite', async () => {
    for (const [status, state] of [
      [503, 'unknown'],
      [429, 'unknown'],
      [403, 'failed'],
    ] as const) {
      fake.failPathOnce('/cashier/signin', status);
      expect((await make().issueSale(sale())).state, String(status)).toBe(state);
    }
  });

  it('a 503 or 500 when opening the shift is unknown; nothing is created', async () => {
    for (const status of [503, 500]) {
      fake.state.shiftOpen = false;
      fake.failPathOnce('/shifts', status);
      const request = sale();
      expect((await make().issueSale(request)).state, String(status)).toBe('unknown');
      expect(fake.receipts.has(request.localReference)).toBe(false);
    }
    fake.state.shiftOpen = false;
  });

  it('a redirect is never followed: the licence key and the body stay with Checkbox', async () => {
    fake.failPathOnce('/receipts/sell', 307, { Location: `${fake.baseUrl}/leak` });
    expect((await make().issueSale(sale())).state).toBe('unknown');
    expect(fake.leaks).toEqual([]);
  });
});
