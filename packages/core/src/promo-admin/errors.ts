import { DomainError } from '../errors.ts';

export class PromoNotFoundError extends DomainError {
  constructor() {
    super('PROMO_NOT_FOUND', 'Promo code not found');
  }
}

export class PromoCodeTakenError extends DomainError {
  constructor() {
    super('PROMO_CODE_TAKEN', 'This promo code already exists');
  }
}

/** A code that was ever redeemed keeps its type, value and scope: old orders must stay explicable. */
export class PromoLockedError extends DomainError {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super('PROMO_LOCKED', `A redeemed promo code cannot change: ${fields.join(', ')}`);
    this.fields = fields;
  }
}

export class PromoLimitBelowUsedError extends DomainError {
  constructor() {
    super('PROMO_LIMIT_BELOW_USED', 'The limit cannot be lower than the uses already counted');
  }
}

export class PromoDatesError extends DomainError {
  constructor() {
    super('PROMO_DATES', 'The end must be after the start');
  }
}

export class PromoScopeTargetError extends DomainError {
  constructor() {
    super('PROMO_SCOPE_TARGET', 'The category or product of the scope does not exist');
  }
}
