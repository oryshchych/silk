/**
 * The confirmation link of a newsletter subscription (double opt-in): `<subscriber id>.<expiry>.<HMAC>` under a
 * key derived from `AUTH_SECRET` for this purpose only (not valid as an unsubscribe or any other token). The
 * expiry is epoch seconds inside the signed text; the database clock decides whether it has passed.
 */
import { createHmac } from 'node:crypto';

import { constantTimeEqual, deriveKey } from '../auth/crypto.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CONFIRM_TOKEN_HOURS = 48;

const sign = (secret: string | undefined, id: string, expires: number): string =>
  createHmac('sha256', deriveKey(secret, 'newsletter-confirm'))
    .update(`v1:${id}:${String(expires)}`)
    .digest('base64url');

export function buildConfirmToken(
  secret: string | undefined,
  id: string,
  nowMs: number = Date.now(),
): string {
  const expires = Math.floor(nowMs / 1000) + CONFIRM_TOKEN_HOURS * 3600;
  return `${id}.${String(expires)}.${sign(secret, id, expires)}`;
}

export function readConfirmToken(
  secret: string | undefined,
  token: string,
): { id: string; expires: number } | null {
  if (token.length > 200) return null;
  const [id, rawExpires, given, ...rest] = token.split('.');
  if (
    rest.length > 0 ||
    id === undefined ||
    rawExpires === undefined ||
    given === undefined ||
    !UUID.test(id) ||
    !/^\d{1,12}$/.test(rawExpires)
  ) {
    return null;
  }
  const expires = Number(rawExpires);
  return constantTimeEqual(given, sign(secret, id, expires)) ? { id, expires } : null;
}
