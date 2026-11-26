/**
 * The unsubscribe link of a back-in-stock mail: `<alert id>.<HMAC(id)>` under a key derived (HKDF)
 * from `AUTH_SECRET` for this purpose only. Kept in its own file with no database or DTO imports, so
 * the worker, the web app and the smoke script can all build and read it.
 */
import { createHmac } from 'node:crypto';

import { constantTimeEqual, deriveKey } from '../auth/crypto.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sign = (secret: string | undefined, id: string): string =>
  createHmac('sha256', deriveKey(secret, 'unsubscribe')).update(`v1:${id}`).digest('base64url');

export const buildUnsubscribeToken = (secret: string | undefined, id: string): string =>
  `${id}.${sign(secret, id)}`;

export function readUnsubscribeToken(secret: string | undefined, token: string): string | null {
  if (token.length > 200) return null;
  const [id, given, ...rest] = token.split('.');
  if (rest.length > 0 || id === undefined || given === undefined || !UUID.test(id)) return null;
  return constantTimeEqual(given, sign(secret, id)) ? id : null;
}
