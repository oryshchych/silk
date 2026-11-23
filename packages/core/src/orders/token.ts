import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of the cart token: it is the credential of a guest intent. */
export function sameToken(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
