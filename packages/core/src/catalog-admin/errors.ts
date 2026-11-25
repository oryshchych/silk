import { DomainError } from '../errors.ts';

export class AdminNotFoundError extends DomainError {
  constructor(what: 'product' | 'variant' | 'category' | 'color' | 'size' | 'attribute') {
    super('ADMIN_NOT_FOUND', `${what} not found`);
  }
}

export class SlugTakenError extends DomainError {
  constructor() {
    super('ADMIN_SLUG_TAKEN', 'This slug is already used');
  }
}

export class SkuTakenError extends DomainError {
  constructor() {
    super('ADMIN_SKU_TAKEN', 'This SKU is already used');
  }
}

export class CategoryCycleError extends DomainError {
  constructor() {
    super('ADMIN_CATEGORY_CYCLE', 'A category cannot be moved under itself or its descendants');
  }
}

export class CategoryTooDeepError extends DomainError {
  constructor() {
    super('ADMIN_CATEGORY_TOO_DEEP', 'The category tree is at most 4 levels deep');
  }
}

export class NotPublishableError extends DomainError {
  constructor(reason: 'no_active_variant' | 'inactive_category') {
    super('ADMIN_NOT_PUBLISHABLE', `The product cannot be published: ${reason}`);
  }
}

export class TooManyVariantsError extends DomainError {
  constructor() {
    super('ADMIN_TOO_MANY_VARIANTS', 'At most 200 variants can be generated at once');
  }
}

export class DuplicateEntryError extends DomainError {
  constructor() {
    super('ADMIN_DUPLICATE', 'This entry already exists');
  }
}
