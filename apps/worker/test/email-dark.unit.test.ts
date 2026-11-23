import { describe, expect, it } from 'vitest';

import {
  renderPaymentFailed,
  renderPaymentReceived,
  renderRefund,
} from '../src/email/payment-emails.ts';
import { PALETTE, renderCustomerEmail, type EmailOrder } from '../src/email/templates.ts';

/** WCAG relative luminance and contrast ratio of two #rrggbb colours. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const facts = {
  orderNumber: 'LS-2026-000042',
  locale: 'uk' as const,
  customerName: 'Ірина <b>x</b>',
  trackUrl: 'https://shop.example/order/track',
};
const order: EmailOrder = {
  ...facts,
  customerEmail: 'i@example.com',
  customerPhone: '+380501234567',
  deliveryLine: 'Самовивіз',
  paymentLabel: 'Картка',
  paymentProvider: 'mono',
  status: 'pending',
  items: [{ name: 'Бюстгальтер', size: '75B', color: 'Чорний', quantity: 1, lineTotal: 129900 }],
  subtotal: 129900,
  discountTotal: 0,
  shippingTotal: 0,
  adjustmentTotal: 0,
  total: 129900,
};

describe('dark mode (the parts that can be proven without Gmail and Outlook)', () => {
  it('text, muted text and links meet WCAG AA (4.5:1) on their ground, in light and in dark', () => {
    for (const scheme of [PALETTE.light, PALETTE.dark]) {
      expect(contrast(scheme.text, scheme.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(scheme.text, scheme.page)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(scheme.muted, scheme.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(scheme.link, scheme.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(scheme.link, scheme.page)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every email declares both colour schemes, overrides them for dark, and has a TEXT wordmark', () => {
    const mails = [
      renderCustomerEmail(order),
      renderPaymentReceived(facts, 129900),
      renderPaymentFailed(facts),
      renderRefund(facts, 5000, false),
    ];
    for (const { html } of mails) {
      expect(html).toContain('<meta name="color-scheme" content="light dark">');
      expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
      expect(html).toContain('@media (prefers-color-scheme: dark)');
      expect(html).toContain('[data-ogsc]');
      expect(html).toContain('LACE &amp; SILK');
      // No image can disappear on a dark ground: the logo is text.
      expect(html).not.toMatch(/<img/i);
    }
  });

  it('the new emails escape what a person typed, carry the number and a track link, and state amounts from kopiykas', () => {
    const received = renderPaymentReceived(facts, 129900);
    expect(received.html).not.toContain('<b>x</b>');
    expect(received.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(received.text).toContain('LS-2026-000042');
    expect(received.text).toContain('https://shop.example/order/track');
    expect(received.text.replace(/\s/g, ' ')).toContain('1 299,00');
    expect(renderRefund(facts, 5000, true).text).toContain('повна сума');
    expect(renderRefund(facts, 5000, false).text).toContain('частина оплати');
  });
});
