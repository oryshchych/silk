/**
 * `email.cart-reminder`: the ONE reminder of an abandoned cart. The queue message carries the cart id only;
 * the address, the goods and the consent are read from the database at send time (`readCartReminder`), so a
 * cart that was converted, a customer who ordered meanwhile or withdrew consent, or goods that sold out
 * send nothing. The unsubscribe link is rebuilt from the subscriber id under a derived key. No prices are
 * shown: a price in a mail can be stale by the time it is read, the cart page shows the real one.
 */
import { z } from 'zod';

import { buildMarketingUnsubscribeToken, readCartReminder } from '@store/core/marketing';
import type { Reader } from '@store/db/types';

import type { EmailSender } from './resend.ts';
import { escapeHtml, oneLine, shell, type EmailLocale, type RenderedEmail } from './templates.ts';

const payload = z
  .object({ cartId: z.uuid(), activeAt: z.iso.datetime(), version: z.number().int().min(0) })
  .strict();

export class CartReminderEmailError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CartReminderEmailError';
  }
}

const COPY = {
  uk: {
    subject: 'Ви залишили товари в кошику',
    intro: 'У вашому кошику на Damazla чекають товари:',
    line: (name: string, size: string, quantity: number) =>
      `${name}, розмір ${size}, кількість: ${String(quantity)}`,
    open: 'Повернутися до кошика',
    why: 'Ви отримали цей лист, бо погодилися на розсилку. Це єдине нагадування про цей кошик.',
    stop: 'Відписатися від розсилки',
  },
  en: {
    subject: 'You left items in your cart',
    intro: 'These items are waiting in your Damazla cart:',
    line: (name: string, size: string, quantity: number) =>
      `${name}, size ${size}, quantity: ${String(quantity)}`,
    open: 'Back to your cart',
    why: 'You get this email because you agreed to our mailing. It is the only reminder about this cart.',
    stop: 'Unsubscribe from the mailing',
  },
} as const;

export function renderCartReminder(input: {
  locale: EmailLocale;
  items: { name: string; size: string; quantity: number }[];
  cartUrl: string;
  unsubscribeUrl: string;
}): RenderedEmail {
  const c = COPY[input.locale];
  const lines = input.items.map((item) => c.line(oneLine(item.name), item.size, item.quantity));
  const text = [
    c.intro,
    ...lines.map((line) => `- ${line}`),
    '',
    `${c.open}: ${input.cartUrl}`,
    '',
    c.why,
    `${c.stop}: ${input.unsubscribeUrl}`,
  ].join('\n');
  const content = [
    `<p>${escapeHtml(c.intro)}</p>`,
    `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
    `<p><a href="${escapeHtml(input.cartUrl)}">${escapeHtml(c.open)}</a></p>`,
    `<p class="muted" style="color:#555555">${escapeHtml(c.why)} <a href="${escapeHtml(input.unsubscribeUrl)}">${escapeHtml(c.stop)}</a></p>`,
  ].join('');
  return {
    subject: c.subject,
    html: shell({ lang: input.locale, title: c.subject, content }),
    text,
  };
}

export async function handleCartReminder(
  deps: { reader: Reader; sender: EmailSender; siteUrl: string; authSecret: string | undefined },
  message: { dedupKey: string; payload: unknown },
): Promise<void> {
  const parsed = payload.safeParse(message.payload);
  if (!parsed.success) throw new CartReminderEmailError('malformed payload');
  const reminder = await readCartReminder(deps.reader, parsed.data);
  if (reminder === null) return;
  // Throws without a strong secret: the job fails into the dead-letter queue, nothing is sent.
  const token = buildMarketingUnsubscribeToken(deps.authSecret, reminder.subscriberId);
  const base = deps.siteUrl.replace(/\/+$/, '');
  const prefix = reminder.locale === 'en' ? '/en' : '';
  await deps.sender.send({
    to: reminder.email,
    ...renderCartReminder({
      locale: reminder.locale,
      items: reminder.items,
      cartUrl: `${base}${prefix}/cart`,
      unsubscribeUrl: `${base}${prefix}/unsubscribe/marketing?t=${encodeURIComponent(token)}`,
    }),
    idempotencyKey: `${message.dedupKey}:customer`,
  });
}
