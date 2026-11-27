import { DomainError } from '../errors.ts';

export class PostNotFoundError extends DomainError {
  constructor() {
    super('BLOG_NOT_FOUND', 'Post not found');
  }
}
export class PostSlugTakenError extends DomainError {
  constructor() {
    super('BLOG_SLUG_TAKEN', 'This address is already used by another post');
  }
}
/** A published post needs a body in at least one language. */
export class PostEmptyError extends DomainError {
  constructor() {
    super('BLOG_EMPTY', 'A post needs text in at least one language before it can be published');
  }
}
export class PostTimeError extends DomainError {
  constructor() {
    super('BLOG_TIME', 'That time does not exist in Kyiv (the clocks skip it)');
  }
}
