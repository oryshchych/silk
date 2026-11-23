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
  /** The storefront always sets it: refuse an order whose total was never shown (Q12). */
  requireQuote?: boolean;
}
