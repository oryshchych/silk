/**
 * The session token: `v1.<sid>.<expiry seconds>.<signature>`, an HMAC-SHA256 over the first three
 * parts. It proves only that WE issued this `sid`; whether the session still counts (revoked,
 * expired, user active, role, MFA) is read from the database on every request (ADR-19).
 * The same token travels as a cookie (web) or an `Authorization: Bearer` header (mobile).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sign = (payload: string, key: Buffer): string =>
  createHmac('sha256', key).update(payload).digest('base64url');

export function signSessionToken(sid: string, expiresAtMs: number, key: Buffer): string {
  const payload = `v1.${sid}.${String(Math.floor(expiresAtMs / 1000))}`;
  return `${payload}.${sign(payload, key)}`;
}

export function readSessionToken(
  token: string,
  key: Buffer,
  nowMs: number,
): { sid: string } | null {
  if (token.length > 200) return null;
  const parts = token.split('.');
  const [version, sid, expiry, signature] = parts;
  if (
    parts.length !== 4 ||
    version !== 'v1' ||
    sid === undefined ||
    expiry === undefined ||
    signature === undefined ||
    !UUID.test(sid) ||
    !/^\d{1,12}$/.test(expiry)
  ) {
    return null;
  }
  const expected = Buffer.from(sign(`v1.${sid}.${expiry}`, key));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return Number(expiry) * 1000 > nowMs ? { sid } : null;
}
