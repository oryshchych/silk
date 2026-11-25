/** TOTP (RFC 6238, SHA-1, 6 digits, 30 s) with the secret in base32 (RFC 4648), as authenticator apps expect. */
import { createHmac, randomBytes } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side of "now": a clock that is a few seconds off still works. */
const WINDOW = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31] ?? '';
  return out;
}

export function base32Decode(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

/** The step number a moment falls in. */
export const stepOf = (epochMs: number): number => Math.floor(epochMs / 1000 / STEP_SECONDS);

export function codeAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  if (key === null) throw new Error('not a base32 secret');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * The step a code is valid for, or null. A step at or before `lastUsedStep` is refused: a code
 * is good once (replay), including its neighbour in the window.
 */
export function matchTotp(
  secret: string,
  code: string,
  epochMs: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepOf(epochMs);
  let found: number | null = null;
  // No early exit: the work does not depend on which step matched.
  for (let step = now - WINDOW; step <= now + WINDOW; step += 1) {
    if (codeAt(secret, step) === code && (lastUsedStep === null || step > lastUsedStep)) {
      found ??= step;
    }
  }
  return found;
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
