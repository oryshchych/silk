import { describe, expect, it } from 'vitest';

import { placeOrderSchema } from './checkout-schemas';
import { payInputSchema } from './pay-schema';

describe('closed sets from outside', () => {
  it('the pay input accepts the two card providers and nothing else, prototype names included', () => {
    expect(payInputSchema.safeParse({ locale: 'uk', provider: 'mono' }).success).toBe(true);
    for (const provider of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'cod',
      'bank_transfer',
      'gift_card',
      'paypal',
      '',
    ]) {
      expect(payInputSchema.safeParse({ locale: 'uk', provider }).success, provider).toBe(false);
    }
    expect(payInputSchema.safeParse({ locale: 'constructor', provider: 'mono' }).success).toBe(
      false,
    );
  });

  it('the order form refuses prototype names as a payment method, delivery or locale', () => {
    const base = {
      locale: 'uk',
      name: 'Ірина',
      email: 'i@example.com',
      phone: '0501234567',
      delivery: 'pickup',
      payment: 'cod',
      terms: true,
    };
    expect(placeOrderSchema.safeParse(base).success).toBe(true);
    for (const bad of ['__proto__', 'constructor', 'toString']) {
      expect(placeOrderSchema.safeParse({ ...base, payment: bad }).success, bad).toBe(false);
      expect(placeOrderSchema.safeParse({ ...base, delivery: bad }).success, bad).toBe(false);
      expect(placeOrderSchema.safeParse({ ...base, locale: bad }).success, bad).toBe(false);
    }
  });
});
