/**
 * Typed domain errors. Callers (server actions, route handlers) map `code` to
 * an HTTP status and a message key; the domain knows nothing about HTTP.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class EmptyCartError extends DomainError {
  constructor() {
    super('CHECKOUT_EMPTY_CART', 'The cart is empty');
  }
}

export class IntentNotFoundError extends DomainError {
  constructor() {
    super('CHECKOUT_INTENT_NOT_FOUND', 'Checkout intent not found');
  }
}

/** The cart changed (e.g. in another tab) after the intent was issued: 409. */
export class StaleCartError extends DomainError {
  constructor() {
    super('CHECKOUT_STALE_CART', 'The cart changed; start checkout again');
  }
}

/** The same intent was resubmitted with a different payload: 409. */
export class IntentPayloadMismatchError extends DomainError {
  constructor() {
    super('CHECKOUT_INTENT_PAYLOAD_MISMATCH', 'The intent was already used with other details');
  }
}

export interface StockProblem {
  variantId: string;
  requested: number;
  available: number;
}

export class InsufficientStockError extends DomainError {
  readonly problems: readonly StockProblem[];

  constructor(problems: readonly StockProblem[]) {
    super('CHECKOUT_INSUFFICIENT_STOCK', 'Some items are no longer available');
    this.problems = problems;
  }
}

/** Gift cards are not sold or redeemed in v1 (docs/GIFT_CARDS.md section 0). */
export class UnsupportedPurchaseError extends DomainError {
  constructor(reason: 'gift_card_product' | 'gift_card_provider') {
    super('CHECKOUT_UNSUPPORTED', `Unsupported purchase: ${reason}`);
  }
}

export class PromoRejectedError extends DomainError {
  constructor(reason: string) {
    super('PROMO_REJECTED', `Promo code rejected: ${reason}`);
  }
}

export class InvalidQuantityError extends DomainError {
  constructor() {
    super('CART_INVALID_QUANTITY', 'Quantity must be an integer from 0 to 99');
  }
}

export class InvalidCartTokenError extends DomainError {
  constructor() {
    super('CART_INVALID_TOKEN', 'Cart token has an invalid format');
  }
}

export class VariantNotFoundError extends DomainError {
  constructor() {
    super('CART_VARIANT_NOT_FOUND', 'The product variant does not exist or is not for sale');
  }
}

/** The cart was already turned into an order; the client must start a new cart. */
export class CartConvertedError extends DomainError {
  constructor() {
    super('CART_CONVERTED', 'This cart was already ordered; start a new cart');
  }
}

export class IntentExpiredError extends DomainError {
  constructor() {
    super('CHECKOUT_INTENT_EXPIRED', 'The checkout intent expired; start checkout again');
  }
}

export class OrderNotPayableError extends DomainError {
  constructor(reason: string) {
    super('PAYMENT_ORDER_NOT_PAYABLE', `The order cannot take a new payment attempt: ${reason}`);
  }
}

/** A previous attempt is in `unknown`: reconcile it with the provider before starting another. */
export class AttemptUnresolvedError extends DomainError {
  constructor() {
    super('PAYMENT_ATTEMPT_UNRESOLVED', 'A previous payment attempt has an unknown result');
  }
}

/** A previous invoice is still live at the provider; the buyer could pay both. */
export class AttemptStillOpenError extends DomainError {
  constructor() {
    super('PAYMENT_ATTEMPT_STILL_OPEN', 'The previous payment attempt is still open');
  }
}

export class OrderNotShippableError extends DomainError {
  constructor(reason: string) {
    super('ORDER_NOT_SHIPPABLE', `The order cannot be shipped: ${reason}`);
  }
}

export class OrderNotCancellableError extends DomainError {
  constructor(reason: string) {
    super('ORDER_NOT_CANCELLABLE', `The order cannot be cancelled: ${reason}`);
  }
}

/** A denormalised counter does not cover a live reservation or promo use: stock:reconcile territory. */
export class StockDriftError extends DomainError {
  constructor(what: string) {
    super('STOCK_COUNTER_DRIFT', `Counter drift detected: ${what}`);
  }
}
