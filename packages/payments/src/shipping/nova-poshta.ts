/**
 * Nova Poshta API 2.0 waybill adapter, written from the public API description. NOT verified
 * against the real API: the key does not exist yet (owner queue Q2), so the request and response
 * shapes are exercised only against the local fake (`test/fake-nova-poshta.ts`, real HTTP). Facts
 * to confirm with the sandbox key: the required properties of `InternetDocument/save` for a
 * private-person recipient, the cash-on-delivery block (`BackwardDeliveryData`), and the print
 * URLs.
 *
 * Idempotency: `InternetDocument/save` has no idempotency key. After a timeout the document may
 * exist, so the adapter reports `unknown` and the caller must not call save again for the order
 * (the database allows one live operation per order, migration 0013). The API key travels only in
 * the request body (and, for printing, in a server-side URL): it is never logged, never returned.
 */
import { z } from 'zod';

import { money, parseHryvnias, toHryvniasText, type Money } from '@store/shared/money';

import { readJsonCapped, ResponseTooLargeError } from '../http.ts';
import {
  isWaybillNumber,
  type PrintKind,
  type WaybillCarrier,
  type WaybillRequest,
  type WaybillResult,
} from './types.ts';

export interface NovaPoshtaConfig {
  apiKey: string;
  /** `https://api.novaposhta.ua/v2.0/json/` in production; plain http for loopback only. */
  baseUrl: string;
  /** `https://my.novaposhta.ua` in production: the host of the printed forms. */
  printBaseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_ERROR = 200;

const envelope = z.object({
  success: z.boolean(),
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  errors: z.array(z.unknown()).optional(),
});

const clean = (value: unknown): string =>
  (typeof value === 'string' ? value : 'the carrier refused the request')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, MAX_ERROR);

const text = (row: Record<string, unknown> | undefined, key: string): string | null => {
  const value = row?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** `1299`, `70.5` or `"70"` from the carrier as kopiykas, without a float. */
function tariff(value: unknown): Money | null {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  try {
    return parseHryvnias(raw);
  } catch {
    return null;
  }
}

/** Grams as the carrier's kilograms string, at least 0.1. */
function kilograms(grams: number): string {
  const safe = Math.max(100, Math.trunc(grams));
  return `${String(Math.trunc(safe / 1000))}.${String(safe % 1000).padStart(3, '0')}`;
}

/** The raw bytes of an answer, stopping at the cap (a PDF is binary: it must not pass through text). */
async function readBytesCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw new ResponseTooLargeError();
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    if (!(chunk instanceof Uint8Array)) throw new SyntaxError('unreadable answer');
    total += chunk.byteLength;
    if (total > maxBytes) throw new ResponseTooLargeError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};

class StepFailed extends Error {}
class StepUnknown extends Error {}

export class NovaPoshtaWaybill implements WaybillCarrier {
  readonly code = 'nova_poshta';
  private readonly config: NovaPoshtaConfig;
  private readonly http: typeof fetch;

  constructor(config: NovaPoshtaConfig) {
    for (const base of [config.baseUrl, config.printBaseUrl]) {
      const url = new URL(base);
      if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
        throw new Error('Nova Poshta URLs must be https: the API key travels in them');
      }
    }
    this.config = config;
    this.http = config.fetch ?? fetch;
  }

  /** One API call. A transport problem or an unreadable answer is `StepUnknown`; a refusal is `StepFailed`. */
  private async call(
    modelName: string,
    calledMethod: string,
    methodProperties: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    let body: unknown;
    try {
      const response = await this.http(this.config.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: this.config.apiKey,
          modelName,
          calledMethod,
          methodProperties,
        }),
        // A redirect would carry the key and the body to another host.
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
      if (!response.ok) throw new StepUnknown(`the carrier answered ${String(response.status)}`);
      body = await readJsonCapped(response);
    } catch (error) {
      if (error instanceof StepUnknown) throw error;
      throw new StepUnknown('the call did not complete');
    }
    const parsed = envelope.safeParse(body);
    if (!parsed.success) throw new StepUnknown('the answer was not understood');
    if (!parsed.data.success) {
      const first = parsed.data.errors?.[0];
      throw new StepFailed(clean(first));
    }
    return parsed.data.data ?? [];
  }

  async createWaybill(request: WaybillRequest): Promise<WaybillResult> {
    // Step 1 creates (or finds) the recipient as a counterparty. No document can exist yet, so a
    // problem here is a definite `failed`, never `unknown`.
    let recipientRef: string;
    let contactRef: string;
    try {
      const rows = await this.call('Counterparty', 'save', {
        CounterpartyType: 'PrivatePerson',
        CounterpartyProperty: 'Recipient',
        FirstName: request.recipient.firstName,
        LastName: request.recipient.lastName,
        MiddleName: '',
        Phone: request.recipient.phone,
      });
      const row = rows[0];
      const contacts = asRecord(row?.['ContactPerson']);
      const list = Array.isArray(contacts['data']) ? contacts['data'] : [];
      const contactRow = asRecord(list[0]);
      const ref = text(row, 'Ref');
      const contactId = text(contactRow, 'Ref');
      if (ref === null || contactId === null) throw new StepFailed('the recipient was not created');
      recipientRef = ref;
      contactRef = contactId;
    } catch (error) {
      if (error instanceof StepFailed) return { state: 'failed', error: error.message };
      return {
        state: 'failed',
        error: 'the carrier was not reachable before any document was made',
      };
    }

    const [year = '', month = '', day = ''] = request.day.split('-');
    const properties: Record<string, unknown> = {
      PayerType: request.payer === 'sender' ? 'Sender' : 'Recipient',
      PaymentMethod: 'Cash',
      DateTime: `${day}.${month}.${year}`,
      CargoType: 'Parcel',
      Weight: kilograms(request.weightGrams),
      ServiceType:
        request.recipient.warehouseRef === null ? 'WarehouseDoors' : 'WarehouseWarehouse',
      SeatsAmount: '1',
      Description: request.description.slice(0, 100),
      Cost: toHryvniasText(request.declaredCost),
      CitySender: request.sender.cityRef,
      Sender: request.sender.senderRef,
      SenderAddress: request.sender.addressRef,
      ContactSender: request.sender.contactRef,
      SendersPhone: request.sender.phone,
      CityRecipient: request.recipient.cityRef,
      Recipient: recipientRef,
      RecipientAddress: request.recipient.warehouseRef ?? '',
      ContactRecipient: contactRef,
      RecipientsPhone: request.recipient.phone,
      // Our reference rides in the document so a lost answer can be matched to it later.
      InfoRegClientBarcodes: request.localReference,
      ...(request.recipient.address === null
        ? {}
        : { RecipientAddressName: request.recipient.address }),
      ...(request.cashOnDelivery === null
        ? {}
        : {
            BackwardDeliveryData: [
              {
                PayerType: 'Recipient',
                CargoType: 'Money',
                RedeliveryString: toHryvniasText(request.cashOnDelivery),
              },
            ],
          }),
    };
    try {
      const rows = await this.call('InternetDocument', 'save', properties);
      const row = rows[0];
      const documentRef = text(row, 'Ref');
      const ttn = text(row, 'IntDocNumber');
      const cost = tariff(row?.['CostOnSite']);
      // An answer that says success but lacks the document is NOT a refusal: it may exist.
      if (documentRef === null || ttn === null || !isWaybillNumber(ttn) || cost === null) {
        return { state: 'unknown', error: 'the carrier answered without a usable document' };
      }
      return { state: 'succeeded', documentRef, ttn, cost: money(cost) };
    } catch (error) {
      if (error instanceof StepFailed) return { state: 'failed', error: error.message };
      return { state: 'unknown', error: 'the result of the call is not known' };
    }
  }

  async print(ttn: string, kind: PrintKind): Promise<Buffer | null> {
    if (!isWaybillNumber(ttn)) return null;
    const form = kind === 'document' ? 'printDocument' : 'printMarking100x100';
    const url = new URL(
      `/orders/${form}/orders[]/${ttn}/type/pdf/apiKey/${encodeURIComponent(this.config.apiKey)}`,
      this.config.printBaseUrl,
    );
    try {
      const response = await this.http(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
      if (!response.ok) return null;
      // Exactly a PDF, by header AND by its first bytes: an HTML page or a script is never relayed.
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/pdf') return null;
      const bytes = await readBytesCapped(response, MAX_PDF_BYTES);
      return bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? bytes : null;
    } catch {
      return null;
    }
  }
}
