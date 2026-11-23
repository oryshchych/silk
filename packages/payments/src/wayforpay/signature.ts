/**
 * WayForPay signs a DEFINED LIST of fields, joined with `;`, with HMAC_MD5 keyed by the merchant
 * secret (hex). A field that is present in the JSON but not in the list is NOT authenticated: it
 * can be changed by anyone, so nothing outside the list may drive a decision (AGENTS.md 4b.2).
 *
 * Amounts are decimal UAH in this API, never kopiykas. They are converted by string handling
 * only: a float would turn 1299.10 into 1299.0999... (AGENTS.md rule 1).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { money, type Money } from '@store/shared/money';

export function hmacMd5(secret: string, fields: readonly string[]): string {
  return createHmac('md5', secret).update(fields.join(';'), 'utf8').digest('hex');
}

/** Fail closed: an absent key, an absent signature or any malformed input is `false`. */
export function signatureMatches(
  secret: string | null,
  fields: readonly string[],
  signature: string | null | undefined,
): boolean {
  if (secret === null || secret === '' || typeof signature !== 'string') return false;
  const expected = Buffer.from(hmacMd5(secret, fields), 'utf8');
  const given = Buffer.from(signature.toLowerCase(), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** 129900 kopiykas -> 1299 (a JSON number WayForPay accepts), 129910 -> 1299.1. String handling only. */
export function toWayForPayAmount(kopiykas: Money): number {
  const digits = String(kopiykas).padStart(3, '0');
  return Number(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
}

/**
 * The amount as WayForPay wrote it (a JSON number or a numeric string) -> kopiykas, or null when
 * it is not a plain non-negative decimal with at most two fraction digits.
 */
export function fromWayForPayAmount(value: number | string): Money | null {
  const text = typeof value === 'number' ? String(value) : value;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;
  const kopiykas = Number(`${match[1] ?? ''}${(match[2] ?? '').padEnd(2, '0')}`);
  return Number.isSafeInteger(kopiykas) ? money(kopiykas) : null;
}
