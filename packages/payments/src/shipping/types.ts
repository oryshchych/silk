/**
 * The carrier port for waybills (phase 5). The adapter never decides what the order's state is:
 * it answers one of three things, and "I do not know" is a real answer (a timeout on
 * `InternetDocument/save` may have created the document; retrying would create a second one).
 */
import type { Money } from '@store/shared/money';

export interface WaybillSender {
  /** The sender's city and counterparty refs in the carrier's system (from `settings.np_sender`). */
  cityRef: string;
  senderRef: string;
  contactRef: string;
  /** The sender's branch or address ref. */
  addressRef: string;
  phone: string;
}

export interface WaybillRequest {
  /** Our reference; it is sent in the document so a lost answer can be matched to a document. */
  localReference: string;
  sender: WaybillSender;
  recipient: {
    firstName: string;
    lastName: string;
    phone: string;
    cityRef: string;
    /** A branch or locker (np_warehouse). */
    warehouseRef: string | null;
    /** A street address (np_courier). */
    address: string | null;
  };
  weightGrams: number;
  declaredCost: Money;
  description: string;
  /** Who pays the carrier: the shop (`sender`) or the buyer (`recipient`). */
  payer: 'sender' | 'recipient';
  /** Cash on delivery: the amount the carrier collects and sends back to the shop. */
  cashOnDelivery: Money | null;
  /** Kyiv calendar day the parcel is handed over, `YYYY-MM-DD`. */
  day: string;
}

export type WaybillResult =
  | {
      state: 'succeeded';
      /** The document ref at the carrier: the identity of the operation, not the printed number. */
      documentRef: string;
      /** The printed waybill number. */
      ttn: string;
      /** The carrier's real tariff for this parcel. */
      cost: Money;
    }
  /** The carrier looked at the request and said no (or it never got as far as creating a document). */
  | { state: 'failed'; error: string }
  /** The call may have created a document: it needs a human or a reconciliation, never a retry. */
  | { state: 'unknown'; error: string };

export type PrintKind = 'document' | 'marking';

export interface WaybillCarrier {
  readonly code: 'nova_poshta';
  createWaybill(request: WaybillRequest): Promise<WaybillResult>;
  /** The printable PDF of a waybill or its marking sticker; the key never leaves the server. */
  print(ttn: string, kind: PrintKind): Promise<Buffer | null>;
}

/** Public tracking page of a waybill number. */
export const trackingUrl = (ttn: string): string =>
  `https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(ttn)}`;

/** Printed waybill numbers are 14 digits; anything else is never put into a URL. */
export const isWaybillNumber = (value: string): boolean => /^\d{14}$/.test(value);
