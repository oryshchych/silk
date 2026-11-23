import { describe, expect, it } from 'vitest';

import { money, ZERO } from '@store/shared/money';

import { escapeLike, normalizeCityQuery } from './np-directory.ts';
import { DEFAULT_SETTINGS, shippingFee } from './rules.ts';

describe('shippingFee', () => {
  const config = DEFAULT_SETTINGS;

  it('pickup is always free', () => {
    expect(shippingFee('pickup', money(1_000), ZERO, config)).toBe(0);
  });

  it('charges the flat rate under the threshold and waives it at exactly the threshold', () => {
    expect(shippingFee('np_warehouse', money(199_999), ZERO, config)).toBe(7_000);
    expect(shippingFee('np_warehouse', money(200_000), ZERO, config)).toBe(0);
  });

  it('judges the goods after the discount', () => {
    expect(shippingFee('ukrposhta', money(210_000), money(20_000), config)).toBe(5_500);
    expect(shippingFee('ukrposhta', money(210_000), money(10_000), config)).toBe(0);
  });

  it('a disabled threshold never waives the fee', () => {
    expect(
      shippingFee('np_courier', money(9_000_000), ZERO, { ...config, freeShippingThreshold: null }),
    ).toBe(12_000);
  });
});

describe('directory query handling', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('100%_\\')).toBe('100\\%\\_\\\\');
  });

  it('normalises whitespace and refuses too short or too long text', () => {
    expect(normalizeCityQuery('  Київ   обл ')).toBe('Київ обл');
    expect(normalizeCityQuery('к')).toBeNull();
    expect(normalizeCityQuery(' '.repeat(10))).toBeNull();
    expect(normalizeCityQuery('я'.repeat(61))).toBeNull();
  });
});
