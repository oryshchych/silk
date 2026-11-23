import { describe, expect, it } from 'vitest';

import { createResendSender, EmailSendError } from '../src/email/resend.ts';
import { renderAdminEmail, renderCustomerEmail, type EmailOrder } from '../src/email/templates.ts';

const order: EmailOrder = {
  orderNumber: 'LS-2026-000042',
  locale: 'uk',
  customerName: 'Ірина <script>alert(1)</script>',
  customerEmail: 'iryna@example.com',
  customerPhone: '+380501234567',
  deliveryLine: 'Нова пошта, відділення, Київ, Відділення №1 "Центр" & <b>',
  paymentLabel: 'Післяплата',
  paymentProvider: 'cod',
  items: [{ name: 'Бюстгальтер', size: '75B', color: 'Чорний', quantity: 2, lineTotal: 259800 }],
  subtotal: 259800,
  discountTotal: 10000,
  shippingTotal: 0,
  total: 249800,
  trackUrl: 'https://shop.example/order/track',
};

describe('order emails', () => {
  it('escapes every person-supplied value in the HTML and keeps the text readable', () => {
    const { html, text } = renderCustomerEmail(order);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;Центр&quot; &amp; &lt;b&gt;');
    expect(text).toContain('Ірина <script>alert(1)</script>');
  });

  it('shows the number, the items, the discount and the total from integer kopiykas', () => {
    const { subject, text } = renderCustomerEmail(order);
    expect(subject).toBe('Замовлення LS-2026-000042 оформлено');
    expect(text).toContain('Бюстгальтер, Чорний, 75B x 2');
    expect(text).toContain('Разом');
    expect(text).toMatch(/2\s?498,00/);
    expect(text).toContain('Менеджер зателефонує');
    expect(text).toContain('https://shop.example/order/track');
  });

  it('renders in English for an English order, with the transfer note', () => {
    const en = renderCustomerEmail({ ...order, locale: 'en', paymentProvider: 'bank_transfer' });
    expect(en.subject).toBe('Order LS-2026-000042 placed');
    expect(en.text).toContain('payment details');
  });

  it('the shop notification has the contact details, is in Ukrainian and has no tracking link', () => {
    const admin = renderAdminEmail({ ...order, locale: 'en' });
    expect(admin.subject).toContain('Нове замовлення LS-2026-000042');
    expect(admin.text).toContain('+380501234567');
    expect(admin.text).toContain('iryna@example.com');
    expect(admin.text).not.toContain('https://shop.example');
  });
});

describe('escaping in the shop notification and the link', () => {
  const hostile: EmailOrder = {
    ...order,
    customerName: 'Eve <a href="//evil">x</a> \'q\'',
    customerPhone: '+380501234567',
    deliveryLine: 'Київ\r\nBcc: evil@example.com',
    trackUrl: 'https://shop.example/order/track"><script>alert(1)</script>',
  };

  it('escapes the contact line of the shop email, quotes included', () => {
    const { html } = renderAdminEmail(hostile);
    expect(html).not.toContain('<a href="//evil">');
    expect(html).toContain('&lt;a href=&quot;//evil&quot;&gt;');
    expect(html).toContain('&#39;q&#39;');
  });

  it('escapes the tracking link attribute', () => {
    const { html } = renderCustomerEmail(hostile);
    expect(html).not.toContain('"><script>');
    expect(html).toContain('track&quot;&gt;&lt;script&gt;');
  });

  it('keeps a buyer text on one line: line breaks and control characters become spaces', () => {
    const { text } = renderCustomerEmail(hostile);
    expect(text).not.toMatch(/\r|\n\s*Bcc:/);
    expect(text).toContain('Київ Bcc: evil@example.com');
  });

  it('the customer email tells a wrongly addressed reader to ignore it', () => {
    expect(renderCustomerEmail(order).text).toContain('просто проігноруйте');
    expect(renderCustomerEmail({ ...order, locale: 'en' }).text).toContain('simply ignore');
  });
});

describe('the Resend sender', () => {
  const message = {
    to: 'real.customer@example.com',
    subject: 'Тема',
    html: '<p>x</p>',
    text: 'x',
    idempotencyKey: 'order-created:1:customer',
  };

  function capture(response: Response | Error) {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    const impl = ((url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >,
      });
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    }) as typeof fetch;
    return { seen, impl };
  }

  it('sends the idempotency key and the bearer key, to the real recipient in production', async () => {
    const { seen, impl } = capture(new Response('{}', { status: 200 }));
    await createResendSender({
      apiKey: 'k',
      from: 'shop@example.com',
      toOverride: null,
      production: true,
      fetchImpl: impl,
    }).send(message);
    expect(seen[0]?.url).toBe('https://api.resend.com/emails');
    expect(seen[0]?.headers['idempotency-key']).toBe('order-created:1:customer');
    expect(seen[0]?.headers['authorization']).toBe('Bearer k');
    expect(seen[0]?.body['to']).toEqual(['real.customer@example.com']);
    expect(seen[0]?.body['subject']).toBe('Тема');
  });

  it('outside production every recipient becomes the catch-all and the subject is marked', async () => {
    const { seen, impl } = capture(new Response('{}', { status: 200 }));
    await createResendSender({
      apiKey: 'k',
      from: 'shop@example.com',
      toOverride: 'catch@example.com',
      production: false,
      fetchImpl: impl,
    }).send(message);
    expect(seen[0]?.body['to']).toEqual(['catch@example.com']);
    expect(String(seen[0]?.body['subject'])).toBe('[staging] Тема');
    expect(JSON.stringify(seen[0]?.body)).not.toContain('real.customer');
  });

  it('refuses to be built outside production without an override', () => {
    expect(() =>
      createResendSender({
        apiKey: 'k',
        from: 'shop@example.com',
        toOverride: null,
        production: false,
      }),
    ).toThrow('EMAIL_TO_OVERRIDE');
  });

  it('a provider error or an unreachable provider fails the job without leaking the body or the address', async () => {
    const bad = capture(
      new Response('{"message":"invalid to real.customer@example.com"}', { status: 422 }),
    );
    const sender = createResendSender({
      apiKey: 'k',
      from: 'shop@example.com',
      toOverride: null,
      production: true,
      fetchImpl: bad.impl,
    });
    await expect(sender.send(message)).rejects.toMatchObject({
      name: 'EmailSendError',
      status: 422,
    });
    await expect(sender.send(message)).rejects.not.toThrow(/real\.customer/);
    const down = capture(new Error('ECONNRESET to real.customer@example.com'));
    const failing = createResendSender({
      apiKey: 'k',
      from: 'shop@example.com',
      toOverride: null,
      production: true,
      fetchImpl: down.impl,
    });
    const error = await failing.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error).toHaveProperty('message', 'email provider unreachable');
  });
});
