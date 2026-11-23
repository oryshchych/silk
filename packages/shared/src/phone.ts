/**
 * Ukrainian mobile numbers in one canonical form, `+380XXXXXXXXX`. Per-phone
 * limits (COD) and order tracking compare this exact string, so every entry
 * point normalises first and the domain refuses anything else.
 */
/** 9 national digits; the first one is the operator or area code start (3, 5, 6, 7 or 9). */
const CANONICAL = /^\+380[35679]\d{8}$/;
const MAX_INPUT_LENGTH = 32;

export const isCanonicalUaPhone = (value: string): boolean => CANONICAL.test(value);

/** `0501234567`, `380501234567`, `+38 (050) 123-45-67` and friends become `+380501234567`; otherwise null. */
export function normalizeUaPhone(raw: string): string | null {
  if (raw.length > MAX_INPUT_LENGTH) return null;
  const digits = raw.replace(/[\s()\-.]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  const international = digits.startsWith('+');
  const plain = international ? digits.slice(1) : digits;
  let national: string;
  // A leading + means the country code is spelled out; the national forms have none.
  if (plain.length === 12 && plain.startsWith('380')) national = plain.slice(3);
  else if (!international && plain.length === 11 && plain.startsWith('80'))
    national = plain.slice(2);
  else if (!international && plain.length === 10 && plain.startsWith('0'))
    national = plain.slice(1);
  else return null;
  const candidate = `+380${national}`;
  return CANONICAL.test(candidate) ? candidate : null;
}
