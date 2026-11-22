/** Input of createOrder. Prices and quantities are deliberately absent (AGENTS.md 2.2). */
export interface CreateOrderInput {
  intentId: string;
  /** Owner of the intent: the guest cart token. A foreign intent is not usable. */
  ownerToken: string;
  contact: { email: string; phone: string; name: string };
  delivery: { method: 'np_warehouse' | 'np_courier' | 'ukrposhta' | 'pickup'; address?: string };
  paymentProvider: 'mono' | 'wayforpay' | 'cod' | 'bank_transfer' | 'gift_card';
  promoCode: string | null;
  locale: 'uk' | 'en';
}
