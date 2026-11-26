import { DomainError } from '../errors.ts';

export class AdminNotFoundError extends DomainError {
  constructor(what: 'product' | 'variant' | 'category' | 'color' | 'size' | 'attribute' | 'order') {
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

export class BarcodeTakenError extends DomainError {
  constructor() {
    super('ADMIN_BARCODE_TAKEN', 'This barcode is already used');
  }
}

/** A permission the action itself did not name but the input needs (e.g. writing a cost). */
export class ForbiddenError extends DomainError {
  constructor() {
    super('FORBIDDEN', 'You do not have permission for this change');
  }
}

/** The uploaded CSV could not be read at all (too big, too many rows, broken quoting, empty). */
export class ImportFileError extends DomainError {
  constructor(reason: string) {
    super(`CSV_${reason.toUpperCase()}`, `The file cannot be imported: ${reason}`);
  }
}
