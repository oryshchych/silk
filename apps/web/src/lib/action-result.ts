import { DomainError } from '@store/core/errors';

import { ERROR_CODES } from './error-codes';

/**
 * Domain error code -> `errors.codes.<key>` message. Anything not listed is shown as the generic
 * message; the code itself is never shown to the buyer.
 */
/** Domain codes that have their own message; the rest are shown as the generic one. */
const KNOWN: ReadonlySet<string> = new Set(ERROR_CODES);

export const GENERIC_CODE = 'GENERIC';

/** The message key for an error: a known domain code, or the generic one. */
export function codeFor(error: unknown): string {
  return error instanceof DomainError && KNOWN.has(error.code) ? error.code : GENERIC_CODE;
}

export type ActionFailure = { ok: false; code: string; retryAfterSeconds?: number };
export const RATE_LIMITED = 'RATE_LIMITED';
