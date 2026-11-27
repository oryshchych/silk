/**
 * The confirmation link of a newsletter subscription (double opt-in): `<subscriber id>.<request nonce>.<expiry>.<HMAC>`
 * under a key derived from `AUTH_SECRET` for this purpose only (not valid as an unsubscribe or any other token).
 * The nonce is the request generation (`newsletter_subscribers.request_nonce`): the confirm UPDATE compares it, and
 * every new request, unsubscribe and confirmation rotates it, so a link works for exactly the request it was
 * mailed for. The expiry is epoch seconds inside the signed text; the database clock decides whether it has passed.
 */
import { createHmac } from 'node:crypto';

import { constantTimeEqual, deriveKey } from '../auth/crypto.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CONFIRM_TOKEN_HOURS = 48;

const sign = (secret: string | undefined, id: string, nonce: string, expires: number): string =>
  createHmac('sha256', deriveKey(secret, 'newsletter-confirm'))
    .update(`v2:${id}:${nonce}:${String(expires)}`)
    .digest('base64url');

export function buildConfirmToken(
  secret: string | undefined,
  id: string,
  nonce: string,
  nowMs: number = Date.now(),
): string {
  const expires = Math.floor(nowMs / 1000) + CONFIRM_TOKEN_HOURS * 3600;
  return `${id}.${nonce}.${String(expires)}.${sign(secret, id, nonce, expires)}`;
}

export function readConfirmToken(
  secret: string | undefined,
  token: string,
): { id: string; nonce: string; expires: number } | null {
  if (token.length > 250) return null;
  const [id, nonce, raw, given, ...rest] = token.split('.');
  if (
    rest.length > 0 ||
    id === undefined ||
    nonce === undefined ||
    raw === undefined ||
    given === undefined ||
    !UUID.test(id) ||
    !UUID.test(nonce) ||
    !/^\d{1,12}$/.test(raw)
  ) {
    return null;
  }
  const expires = Number(raw);
  // A spelling the signature was not made over (leading zeros) is refused, not normalised.
  if (String(expires) !== raw) return null;
  return constantTimeEqual(given, sign(secret, id, nonce, expires)) ? { id, nonce, expires } : null;
}
