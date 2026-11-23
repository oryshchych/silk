/** Every code an action can hand to the browser; each has a message under `errors.codes`. */
export const ERROR_CODES = [
  'CART_INVALID_QUANTITY',
  'CART_VARIANT_NOT_FOUND',
  'CART_CONVERTED',
  'CHECKOUT_EMPTY_CART',
  'CHECKOUT_STALE_CART',
  'CHECKOUT_INTENT_EXPIRED',
  'CHECKOUT_INTENT_NOT_FOUND',
  'CHECKOUT_DELIVERY_INVALID',
  'CHECKOUT_PAYMENT_UNAVAILABLE',
  'CHECKOUT_COD_NOT_ALLOWED',
  'CHECKOUT_QUOTE_REQUIRED',
  'CHECKOUT_TERMS_REQUIRED',
  'CHECKOUT_CONTACT_INVALID',
  'CHECKOUT_UNSUPPORTED',
  'CHECKOUT_PRICE_CHANGED',
  'CHECKOUT_INSUFFICIENT_STOCK',
  'PROMO_REJECTED',
  'INVALID_FIELDS',
  'RATE_LIMITED',
  'TRACK_NOT_FOUND',
  'GENERIC',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(ERROR_CODES);

/** A code the messages know; anything else is shown as the generic message. */
export const messageCode = (code: string): ErrorCode =>
  ERROR_CODES.find((known) => known === code && KNOWN.has(code)) ?? 'GENERIC';
