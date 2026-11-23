import { describe, expect, it } from 'vitest';

import { isCanonicalUaPhone, normalizeUaPhone } from './phone';

describe('normalizeUaPhone', () => {
  it.each([
    '+380501234567',
    '380501234567',
    '0501234567',
    '80501234567',
    '+38 (050) 123-45-67',
    '050 123 45 67',
    '050.123.45.67',
  ])('writes %s as +380501234567', (input) => {
    expect(normalizeUaPhone(input)).toBe('+380501234567');
  });

  it.each([
    '',
    'abc',
    '12345',
    '+4915112345678',
    '05012345678',
    '+3805012345',
    '0501234567x',
    '++380501234567',
    '+0501234567',
    '+80501234567',
    '0000000000',
    '+380000000000',
    `0${'5'.repeat(40)}`,
  ])('refuses %j', (input) => {
    expect(normalizeUaPhone(input)).toBeNull();
  });

  it('recognises only the canonical form', () => {
    expect(isCanonicalUaPhone('+380501234567')).toBe(true);
    expect(isCanonicalUaPhone('0501234567')).toBe(false);
  });
});
