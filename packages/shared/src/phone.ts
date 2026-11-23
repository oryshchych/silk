/**
 * Ukrainian mobile numbers in one canonical form, `+380XXXXXXXXX`. Per-phone
 * limits (COD) and order tracking compare this exact string, so every entry
 * point normalises first and the domain refuses anything else.
 */
const CANONICAL = /^\+380\d{9}$/;

export const isCanonicalUaPhone = (value: string): boolean => CANONICAL.test(value);

/** `0501234567`, `380501234567`, `+38 (050) 123-45-67` and friends become `+380501234567`; otherwise null. */
export function normalizeUaPhone(raw: string): string | null {
  const digits = raw.replace(/[\s()\-.]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  const plain = digits.startsWith('+') ? digits.slice(1) : digits;
  let national: string;
  if (plain.length === 12 && plain.startsWith('380')) national = plain.slice(3);
  else if (plain.length === 11 && plain.startsWith('80')) national = plain.slice(2);
  else if (plain.length === 10 && plain.startsWith('0')) national = plain.slice(1);
  else return null;
  const candidate = `+380${national}`;
  return CANONICAL.test(candidate) ? candidate : null;
}
