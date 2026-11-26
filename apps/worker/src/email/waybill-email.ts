/**
 * `email.waybill-created`: the buyer is told the parcel has a waybill number and gets the carrier's
 * tracking link. The queue message carries the order id only; the number is read from the database
 * when the mail is sent (a waybill that was removed since sends nothing), and the dedup key is the
 * provider's idempotency key, so a retried job never mails twice.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { orders } from '@store/db/schema';
import type { Reader } from '@store/db/types';
import { trackingUrl } from '@store/payments/shipping';

import { loadEmailOrder, OrderEmailError } from './order-created.ts';
import type { EmailSender } from './resend.ts';
import { escapeHtml, oneLine, shell, type EmailLocale, type RenderedEmail } from './templates.ts';

const payload = z.object({ orderId: z.uuid() });

const COPY = {
  uk: {
    hello: (name: string) => `Вітаємо, ${name}!`,
    subject: (n: string) => `Замовлення ${n} відправлено`,
    line: 'Ми відправили ваше замовлення Новою Поштою. Номер накладної:',
    track: 'Відстежити посилку',
    number: 'Номер замовлення',
    notYou: 'Якщо ви не робили цього замовлення, просто проігноруйте цей лист.',
  },
  en: {
    hello: (name: string) => `Hello, ${name}!`,
    subject: (n: string) => `Order ${n} has been shipped`,
    line: 'We sent your order with Nova Poshta. The waybill number is:',
    track: 'Track the parcel',
    number: 'Order number',
    notYou: 'If you did not place this order, simply ignore this email.',
  },
} as const;

export function renderWaybillCreated(facts: {
  orderNumber: string;
  locale: EmailLocale;
  customerName: string;
  ttn: string;
}): RenderedEmail {
  const c = COPY[facts.locale];
  const name = oneLine(facts.customerName);
  const url = trackingUrl(facts.ttn);
  const subject = c.subject(facts.orderNumber);
  const text = [
    c.hello(name),
    '',
    `${c.line} ${facts.ttn}`,
    `${c.track}: ${url}`,
    '',
    `${c.number}: ${facts.orderNumber}`,
    '',
    c.notYou,
  ].join('\n');
  const content = [
    `<h1>${escapeHtml(c.hello(name))}</h1>`,
    `<p>${escapeHtml(c.line)} <strong>${escapeHtml(facts.ttn)}</strong></p>`,
    `<p><a href="${escapeHtml(url)}">${escapeHtml(c.track)}</a></p>`,
    `<p><strong>${escapeHtml(c.number)}:</strong> ${escapeHtml(facts.orderNumber)}</p>`,
    `<p class="muted" style="color:#555555">${escapeHtml(c.notYou)}</p>`,
  ].join('');
  return { subject, html: shell({ lang: facts.locale, title: subject, content }), text };
}

export async function handleWaybillCreated(
  deps: { reader: Reader; sender: EmailSender; siteUrl: string },
  message: { dedupKey: string; payload: unknown },
): Promise<void> {
  const parsed = payload.safeParse(message.payload);
  if (!parsed.success) throw new OrderEmailError('malformed payload');
  const order = await loadEmailOrder(deps.reader, parsed.data.orderId, deps.siteUrl);
  const [row] = await deps.reader
    .select({ ttn: orders.ttn })
    .from(orders)
    .where(eq(orders.id, parsed.data.orderId));
  // No number now (the waybill was taken off the order): there is nothing true to tell the buyer.
  if (row?.ttn == null) return;
  await deps.sender.send({
    to: order.customerEmail,
    ...renderWaybillCreated({ ...order, ttn: row.ttn }),
    idempotencyKey: `${message.dedupKey}:customer`,
  });
}
