import { describe, expect, it } from 'vitest';

import { base32Decode, base32Encode, codeAt, matchTotp, otpauthUri, stepOf } from './totp.ts';

// RFC 6238 appendix B: SHA-1, secret "12345678901234567890"; the RFC lists 8 digits, we use the last 6.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];
    for (const [seconds, code] of vectors) {
      expect(codeAt(RFC_SECRET, stepOf(seconds * 1000)), String(seconds)).toBe(code);
    }
  });

  it('base32 round-trips and rejects foreign characters', () => {
    const bytes = Buffer.from('silk admin secret!');
    expect(base32Decode(base32Encode(bytes))?.equals(bytes)).toBe(true);
    expect(base32Decode('not*base32')).toBeNull();
  });

  it('accepts one step of clock drift either way, not two', () => {
    const now = 1_700_000_000_000;
    const step = stepOf(now);
    expect(matchTotp(RFC_SECRET, codeAt(RFC_SECRET, step), now, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, codeAt(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, codeAt(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, codeAt(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(RFC_SECRET, step + 2), now, null)).toBeNull();
  });

  it('refuses a code whose step was already used (replay), and anything not 6 digits', () => {
    const now = 1_700_000_000_000;
    const step = stepOf(now);
    expect(matchTotp(RFC_SECRET, codeAt(RFC_SECRET, step), now, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(RFC_SECRET, step - 1), now, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(matchTotp(RFC_SECRET, bad, now, null), bad).toBeNull();
    }
  });

  it('builds an otpauth uri with the account and issuer escaped', () => {
    const uri = otpauthUri('ABC', 'a+b@example.com', 'Silk admin');
    expect(uri).toBe(
      'otpauth://totp/Silk%20admin:a%2Bb%40example.com?secret=ABC&issuer=Silk+admin&algorithm=SHA1&digits=6&period=30',
    );
  });
});
