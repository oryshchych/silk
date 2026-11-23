import { describe, expect, it } from 'vitest';

import { ERROR_CODES, messageCode } from './error-codes';
import { addToCartSchema, placeOrderSchema, quoteSchema, trackSchema } from './checkout-schemas';

const valid = {
  locale: 'uk',
  name: 'Іван Петренко',
  email: 'ivan@example.com',
  phone: '050 123 45 67',
  delivery: 'np_warehouse',
  settlementRef: 'city',
  warehouseRef: 'branch',
  payment: 'cod',
  promoCode: ' SAVE ',
  terms: true,
} as const;

describe('placeOrderSchema', () => {
  it('writes the phone in the canonical form and trims text', () => {
    const parsed = placeOrderSchema.parse(valid);
    expect(parsed.phone).toBe('+380501234567');
    expect(parsed.promoCode).toBe('SAVE');
  });

  it('drops fields the browser must never control: prices, totals, the intent, the quote opt-out', () => {
    const parsed = placeOrderSchema.parse({
      ...valid,
      total: 1,
      unitPrice: 1,
      quotedTotal: 1,
      intentId: 'x',
      allowUnquoted: true,
      ownerToken: 'x',
    });
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'address',
        'delivery',
        'email',
        'locale',
        'name',
        'payment',
        'phone',
        'promoCode',
        'settlementRef',
        'terms',
        'warehouseRef',
      ]
        .filter((key) => key in parsed)
        .sort(),
    );
    expect(JSON.stringify(parsed)).not.toMatch(
      /total|unitPrice|intentId|allowUnquoted|ownerToken/i,
    );
  });

  it.each([
    ['a bad phone', { phone: '12345' }],
    ['a short name', { name: 'I' }],
    ['a bad email', { email: 'nope' }],
    ['an unknown delivery method', { delivery: 'drone' }],
    ['the gift card provider', { payment: 'gift_card' }],
    ['an unknown locale', { locale: 'de' }],
    ['an over-long promo code', { promoCode: 'x'.repeat(65) }],
    ['the terms not accepted', { terms: false }],
    ['the terms missing', { terms: undefined }],
    ['a NUL byte in the name', { name: 'Іван\u0000' }],
    ['a NUL byte in the promo code', { promoCode: 'A\u0000B' }],
  ])('refuses %s', (_label, over) => {
    expect(placeOrderSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });
});

describe('the other schemas', () => {
  it('quote needs a known delivery method and locale', () => {
    expect(quoteSchema.safeParse({ locale: 'en', delivery: 'pickup' }).success).toBe(true);
    expect(quoteSchema.safeParse({ locale: 'en', delivery: 'x' }).success).toBe(false);
  });

  it('add to cart takes a uuid and a quantity of 1 to 99', () => {
    const variantId = '0193f0a4-7c3e-7000-8000-000000000001';
    expect(addToCartSchema.parse({ variantId }).quantity).toBe(1);
    expect(addToCartSchema.safeParse({ variantId, quantity: 0 }).success).toBe(false);
    expect(addToCartSchema.safeParse({ variantId, quantity: 100 }).success).toBe(false);
    expect(addToCartSchema.safeParse({ variantId: 'nope' }).success).toBe(false);
  });

  it('tracking normalises the phone and refuses an unreadable one', () => {
    expect(trackSchema.parse({ orderNumber: 'LS-2026-000001', phone: '0501234567' }).phone).toBe(
      '+380501234567',
    );
    expect(trackSchema.safeParse({ orderNumber: 'x', phone: 'abc' }).success).toBe(false);
  });
});

describe('messageCode', () => {
  it('passes known codes and turns anything else into the generic one', () => {
    for (const code of ERROR_CODES) expect(messageCode(code)).toBe(code);
    expect(messageCode('STOCK_COUNTER_DRIFT')).toBe('GENERIC');
    expect(messageCode('')).toBe('GENERIC');
  });
});
