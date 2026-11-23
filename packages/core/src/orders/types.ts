import type { DeliveryMethod, PaymentProvider } from '../shipping/rules.ts';

/** Input of createOrder. Prices and quantities are deliberately absent (AGENTS.md 2.2). */
export interface CreateOrderInput {
  intentId: string;
  /** Owner of the intent: the guest cart token. A foreign intent is not usable. */
  ownerToken: string;
  contact: { email: string; phone: string; name: string };
  delivery: {
    method: DeliveryMethod;
    /** Nova Poshta city ref (np_warehouse, np_courier). */
    settlementRef?: string;
    /** Nova Poshta branch or locker ref (np_warehouse). */
    warehouseRef?: string;
    /** Street address (np_courier) or the full address (ukrposhta). */
    address?: string;
  };
  paymentProvider: PaymentProvider;
  promoCode: string | null;
  locale: 'uk' | 'en';
  /**
   * The buyer accepted the terms and the privacy policy. Required: an order without it is refused,
   * and the acceptance is recorded in the order's audit entry (the texts themselves arrive with
   * phase 8, so no version is stored yet).
   */
  termsAccepted: boolean;
  /**
   * Q12: by default an order whose total was never quoted is refused. Only code that creates
   * orders without a buyer looking at a total (tests, a future admin tool) opts out.
   */
  allowUnquoted?: boolean;
}
