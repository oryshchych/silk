import { DomainError } from '../errors.ts';

export class BannerNotFoundError extends DomainError {
  constructor() {
    super('BANNER_NOT_FOUND', 'Banner not found');
  }
}
/** Only a complete banner can be active: both pictures and alt text in both languages. */
export class BannerIncompleteError extends DomainError {
  constructor() {
    super(
      'BANNER_INCOMPLETE',
      'A banner needs both pictures and alt text in both languages before it can be shown',
    );
  }
}
export class BannerDatesError extends DomainError {
  constructor() {
    super('BANNER_DATES', 'The end must be after the start');
  }
}
export class TooManyBannersError extends DomainError {
  constructor() {
    super('BANNER_TOO_MANY', 'Too many banners: delete an old one first');
  }
}
