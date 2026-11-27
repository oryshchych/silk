import { describe, expect, it } from 'vitest';

import { renderCartReminder } from './cart-reminder.ts';

const input = {
  items: [{ name: 'Bra <script>alert(1)</script>\nA', size: '75B', quantity: 2 }],
  cartUrl: 'https://shop.example/cart',
  unsubscribeUrl: 'https://shop.example/unsubscribe/marketing?t=abc',
};

describe('renderCartReminder', () => {
  it.each(['uk', 'en'] as const)(
    '%s: carries the goods, the cart link and the unsubscribe link, escaped',
    (locale) => {
      const mail = renderCartReminder({ locale, ...input });
      expect(mail.text).toContain('75B');
      expect(mail.text).toContain(input.cartUrl);
      expect(mail.text).toContain(input.unsubscribeUrl);
      expect(mail.html).toContain(input.unsubscribeUrl);
      expect(mail.html).not.toContain('<script>');
      expect(mail.text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
    },
  );

  it('shows no price (a price in a mail can be stale)', () => {
    expect(renderCartReminder({ locale: 'en', ...input }).text).not.toMatch(/₴|UAH|грн/);
  });
});
