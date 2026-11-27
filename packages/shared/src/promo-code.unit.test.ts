import { describe, expect, it } from 'vitest';

import { generatePromoCode, GENERATED_PROMO_CODE_LENGTH, PROMO_CODE_ALPHABET } from './promo-code';

describe('generatePromoCode', () => {
  it('is 8 characters from an alphabet without 0, O, 1, I and L', () => {
    expect(PROMO_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    for (let start = 0; start < 50; start += 1) {
      let n = start;
      const code = generatePromoCode((limit) => (n += 7) % limit);
      expect(code).toHaveLength(GENERATED_PROMO_CODE_LENGTH);
      expect(code).toMatch(/^[A-Z2-9]+$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });
});
