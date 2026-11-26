import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { money } from '@store/shared/money';

import { NovaPoshtaWaybill } from '../src/shipping/nova-poshta.ts';
import type { WaybillRequest } from '../src/shipping/types.ts';
import { FAKE_NP_KEY, startFakeNovaPoshta, type FakeNovaPoshta } from './fake-nova-poshta.ts';

let fake: FakeNovaPoshta;
let carrier: NovaPoshtaWaybill;
const make = (overrides: Partial<ConstructorParameters<typeof NovaPoshtaWaybill>[0]> = {}) =>
  new NovaPoshtaWaybill({
    apiKey: FAKE_NP_KEY,
    baseUrl: fake.baseUrl,
    printBaseUrl: fake.printBaseUrl,
    timeoutMs: 300,
    ...overrides,
  });

beforeAll(async () => {
  fake = await startFakeNovaPoshta();
  carrier = make();
});
afterAll(async () => {
  await fake.close();
});
afterEach(() => {
  fake.reset();
});

const request = (overrides: Partial<WaybillRequest> = {}): WaybillRequest => ({
  localReference: '11111111-1111-4111-8111-111111111111',
  sender: {
    cityRef: 'c',
    senderRef: 's',
    contactRef: 'k',
    addressRef: 'a',
    phone: '+380441112233',
  },
  recipient: {
    firstName: 'Іван',
    lastName: 'Петренко',
    phone: '+380501112233',
    cityRef: 'city-1',
    warehouseRef: 'wh-1',
    address: null,
  },
  weightGrams: 400,
  declaredCost: money(129_900),
  description: 'Одяг',
  payer: 'sender',
  cashOnDelivery: null,
  day: '2026-11-27',
  ...overrides,
});

describe('createWaybill against the local Nova Poshta', () => {
  it('returns the document, the printed number and the real tariff in kopiykas', async () => {
    fake.onSave(() => ({ kind: 'ok', cost: '70.5' }));
    const result = await carrier.createWaybill(request());
    expect(result).toMatchObject({ state: 'succeeded', cost: 7050 });
    if (result.state !== 'succeeded') return;
    expect(result.ttn).toMatch(/^\d{14}$/);
    expect(result.documentRef).toBe(`doc-${result.ttn}`);
    const save = fake.calls.find((c) => c.method === 'save' && c.model === 'InternetDocument');
    expect(save?.properties).toMatchObject({
      PayerType: 'Sender',
      Weight: '0.400',
      Cost: '1299.00',
      DateTime: '27.11.2026',
      ServiceType: 'WarehouseWarehouse',
      RecipientAddress: 'wh-1',
      InfoRegClientBarcodes: '11111111-1111-4111-8111-111111111111',
    });
    // The key is in the request body only: nothing the fake recorded as a property holds it.
    expect(JSON.stringify(fake.calls)).not.toContain(FAKE_NP_KEY);
  });

  it('a courier order sends the address; cash on delivery sends the amount to collect', async () => {
    await carrier.createWaybill(
      request({
        recipient: {
          ...request().recipient,
          warehouseRef: null,
          address: 'вул. Хрещатик 1, кв. 2',
        },
        cashOnDelivery: money(129_900),
        payer: 'recipient',
      }),
    );
    const save = fake.calls.find((c) => c.model === 'InternetDocument');
    expect(save?.properties).toMatchObject({
      ServiceType: 'WarehouseDoors',
      PayerType: 'Recipient',
      RecipientAddressName: 'вул. Хрещатик 1, кв. 2',
      BackwardDeliveryData: [{ RedeliveryString: '1299.00' }],
    });
  });

  it('weights are whole grams turned into kilograms without a float, never under 0.1', async () => {
    for (const [grams, expected] of [
      [50, '0.100'],
      [1500, '1.500'],
      [12_345, '12.345'],
    ] as const) {
      fake.reset();
      await carrier.createWaybill(request({ weightGrams: grams }));
      expect(fake.calls.find((c) => c.model === 'InternetDocument')?.properties['Weight']).toBe(
        expected,
      );
    }
  });

  it('a refusal by the carrier is FAILED with its text, and no document exists', async () => {
    fake.onSave(() => ({ kind: 'error', errors: ['Recipient phone is invalid'] }));
    expect(await carrier.createWaybill(request())).toEqual({
      state: 'failed',
      error: 'Recipient phone is invalid',
    });
    expect(fake.documents.size).toBe(0);
  });

  it('a wrong key is refused at the first step: FAILED, before any document could exist', async () => {
    const result = await make({ apiKey: 'not-the-key' }).createWaybill(request());
    expect(result.state).toBe('failed');
    expect(fake.calls.some((c) => c.model === 'InternetDocument')).toBe(false);
  });

  it.each([
    ['a hang (the document WAS created)', { kind: 'created-but-hang' as const }],
    ['a plain hang', { kind: 'hang' as const }],
    ['an HTTP 502', { kind: 'http' as const, status: 502 }],
    ['a maintenance page', { kind: 'garbage' as const }],
    ['success without a document', { kind: 'empty' as const }],
  ])('%s is UNKNOWN: it must never be retried blindly', async (_name, reply) => {
    fake.onSave(() => reply);
    const result = await carrier.createWaybill(request());
    expect(result.state).toBe('unknown');
    if (reply.kind === 'created-but-hang') expect(fake.documents.size).toBe(1);
  });

  it('a carrier that is down before the document step is FAILED (nothing was created)', async () => {
    const dead = await startFakeNovaPoshta();
    const url = dead.baseUrl;
    await dead.close();
    const result = await make({ baseUrl: url }).createWaybill(request());
    expect(result.state).toBe('failed');
  });

  it('refuses a plain-http base that is not loopback', () => {
    expect(() => make({ baseUrl: 'http://api.example.com/v2.0/json/' })).toThrow();
    expect(() => make({ printBaseUrl: 'http://my.example.com' })).toThrow();
  });
});

describe('print', () => {
  it('returns the PDF bytes untouched and keeps the key on the server', async () => {
    const pdf = await carrier.print('59000000000001', 'document');
    expect(pdf).toEqual(
      Buffer.concat([Buffer.from('%PDF-'), Buffer.from([0xff, 0xfe, 0x00, 0x80])]),
    );
    expect(await carrier.print('59000000000001', 'marking')).not.toBeNull();
    expect(fake.printHits).toEqual([
      'printDocument:59000000000001',
      'printMarking100x100:59000000000001',
    ]);
  });

  it('never builds a URL from anything but a 14-digit number', async () => {
    for (const bad of [
      '',
      '123',
      '5900000000000a',
      '../../etc/passwd',
      '59000000000001/../x',
      '590000000000011',
    ]) {
      expect(await carrier.print(bad, 'document'), bad).toBeNull();
    }
    expect(fake.printHits).toEqual([]);
  });

  it('a wrong key, a non-PDF answer or a dead host gives null, not a throw', async () => {
    expect(await make({ apiKey: 'wrong' }).print('59000000000001', 'document')).toBeNull();
    const dead = await startFakeNovaPoshta();
    const url = dead.printBaseUrl;
    await dead.close();
    expect(await make({ printBaseUrl: url }).print('59000000000001', 'document')).toBeNull();
  });
});

describe('print guards', () => {
  it('a redirect is an error: the key never follows it', async () => {
    fake.setPrintMode('redirect');
    expect(await carrier.print('59000000000001', 'document')).toBeNull();
    expect(fake.leakHits).toEqual([]);
  });

  it.each([
    ['an HTML page', 'html' as const],
    ['a body that is not a PDF (no %PDF- bytes)', 'badmagic' as const],
  ])('%s is never relayed', async (_name, mode) => {
    fake.setPrintMode(mode);
    expect(await carrier.print('59000000000001', 'document')).toBeNull();
  });

  it('an answer that declares more than the cap, an endless one and a stalled one are null, within the timeout', async () => {
    for (const mode of ['huge', 'endless', 'slow'] as const) {
      fake.setPrintMode(mode);
      const started = performance.now();
      expect(await carrier.print('59000000000001', 'document'), mode).toBeNull();
      expect(performance.now() - started, mode).toBeLessThan(2500);
    }
  });
});
