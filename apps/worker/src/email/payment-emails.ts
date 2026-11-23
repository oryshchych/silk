/**
 * Payment and refund emails: `email.payment-received`, `email.payment-failed`,
 * `email.refund-issued`. Like the order email, the queue message carries ids only; the order is
 * read from the database when the mail is sent, and each message has its own idempotency key so a
 * retried job never mails twice. A refund amount is read from `refund_operations`, never from the
 * payload.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { refundOperations } from '@store/db/schema';
import type { Reader } from '@store/db/types';
import { formatMoney, money } from '@store/shared/money';

import { loadEmailOrder, OrderEmailError } from './order-created.ts';
import type { EmailSender } from './resend.ts';
import { escapeHtml, oneLine, shell, type EmailLocale, type RenderedEmail } from './templates.ts';

const received = z.object({ orderId: z.uuid() });
const refund = z.object({ orderId: z.uuid(), operationId: z.uuid() });

const COPY = {
  uk: {
    hello: (name: string) => `Вітаємо, ${name}!`,
    number: 'Номер замовлення',
    track: 'Відстежити замовлення (потрібні номер і телефон)',
    notYou: 'Якщо ви не робили цього замовлення, просто проігноруйте цей лист.',
    receivedSubject: (n: string) => `Оплату замовлення ${n} отримано`,
    receivedText: (amount: string) =>
      `Дякуємо! Ми отримали оплату ${amount}. Починаємо готувати замовлення.`,
    failedSubject: (n: string) => `Оплата замовлення ${n} не пройшла`,
    failedText:
      'Оплата не пройшла. Замовлення ще збережене за вами на короткий час: відкрийте його в браузері, де оформлювали, і спробуйте ще раз, іншою карткою або іншим провайдером.',
    refundSubject: (n: string) => `Повернення коштів за замовленням ${n}`,
    refundFull: (amount: string) => `Ми повернули ${amount}: це повна сума оплати.`,
    refundPartial: (amount: string) => `Ми повернули ${amount}: це частина оплати.`,
    refundLater: 'Кошти надходять на картку протягом кількох банківських днів.',
  },
  en: {
    hello: (name: string) => `Hello, ${name}!`,
    number: 'Order number',
    track: 'Track your order (order number and phone needed)',
    notYou: 'If you did not place this order, simply ignore this email.',
    receivedSubject: (n: string) => `Payment for order ${n} received`,
    receivedText: (amount: string) =>
      `Thank you! We received your payment of ${amount}. We are getting the order ready.`,
    failedSubject: (n: string) => `Payment for order ${n} did not go through`,
    failedText:
      'The payment did not go through. Your order is still held for you for a short time: open it in the browser where you ordered and try again, with another card or another provider.',
    refundSubject: (n: string) => `Refund for order ${n}`,
    refundFull: (amount: string) => `We refunded ${amount}: the full amount you paid.`,
    refundPartial: (amount: string) => `We refunded ${amount}: part of the amount you paid.`,
    refundLater: 'The money reaches your card within a few banking days.',
  },
} as const;

interface Facts {
  orderNumber: string;
  locale: EmailLocale;
  customerName: string;
  trackUrl: string;
}

function frame(facts: Facts, subject: string, lines: string[]): RenderedEmail {
  const c = COPY[facts.locale];
  const name = oneLine(facts.customerName);
  const text = [
    c.hello(name),
    '',
    ...lines,
    '',
    `${c.number}: ${facts.orderNumber}`,
    `${c.track}: ${facts.trackUrl}`,
    '',
    c.notYou,
  ].join('\n');
  const content = [
    `<h1>${escapeHtml(c.hello(name))}</h1>`,
    ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><strong>${escapeHtml(c.number)}:</strong> ${escapeHtml(facts.orderNumber)}</p>`,
    `<p><a href="${escapeHtml(facts.trackUrl)}">${escapeHtml(c.track)}</a></p>`,
    `<p class="muted" style="color:#555555">${escapeHtml(c.notYou)}</p>`,
  ].join('');
  return { subject, html: shell({ lang: facts.locale, title: subject, content }), text };
}

export function renderPaymentReceived(facts: Facts, amountKopiykas: number): RenderedEmail {
  const c = COPY[facts.locale];
  const amount = formatMoney(money(amountKopiykas), facts.locale);
  return frame(facts, c.receivedSubject(facts.orderNumber), [c.receivedText(amount)]);
}

export function renderPaymentFailed(facts: Facts): RenderedEmail {
  const c = COPY[facts.locale];
  return frame(facts, c.failedSubject(facts.orderNumber), [c.failedText]);
}

export function renderRefund(facts: Facts, amountKopiykas: number, full: boolean): RenderedEmail {
  const c = COPY[facts.locale];
  const amount = formatMoney(money(amountKopiykas), facts.locale);
  return frame(facts, c.refundSubject(facts.orderNumber), [
    full ? c.refundFull(amount) : c.refundPartial(amount),
    c.refundLater,
  ]);
}

interface Deps {
  reader: Reader;
  sender: EmailSender;
  siteUrl: string;
}
interface Message {
  dedupKey: string;
  payload: unknown;
}

export async function handlePaymentReceived(deps: Deps, message: Message): Promise<void> {
  const parsed = received.safeParse(message.payload);
  if (!parsed.success) throw new OrderEmailError('malformed payload');
  const order = await loadEmailOrder(deps.reader, parsed.data.orderId, deps.siteUrl);
  await deps.sender.send({
    to: order.customerEmail,
    ...renderPaymentReceived(order, order.total),
    idempotencyKey: `${message.dedupKey}:customer`,
  });
}

export async function handlePaymentFailed(deps: Deps, message: Message): Promise<void> {
  const parsed = received.safeParse(message.payload);
  if (!parsed.success) throw new OrderEmailError('malformed payload');
  const order = await loadEmailOrder(deps.reader, parsed.data.orderId, deps.siteUrl);
  // A cancelled order cannot be paid any more: "try again" would be a lie.
  if (order.status === 'cancelled') return;
  await deps.sender.send({
    to: order.customerEmail,
    ...renderPaymentFailed(order),
    idempotencyKey: `${message.dedupKey}:customer`,
  });
}

export async function handleRefundIssued(deps: Deps, message: Message): Promise<void> {
  const parsed = refund.safeParse(message.payload);
  if (!parsed.success) throw new OrderEmailError('malformed payload');
  const [operation] = await deps.reader
    .select({ amount: refundOperations.amount, orderId: refundOperations.orderId })
    .from(refundOperations)
    .where(eq(refundOperations.id, parsed.data.operationId));
  // The payload names the order too: both must agree, or the message is not ours to send.
  if (operation === undefined || operation.orderId !== parsed.data.orderId) {
    throw new OrderEmailError('refund operation not found');
  }
  const order = await loadEmailOrder(deps.reader, parsed.data.orderId, deps.siteUrl);
  await deps.sender.send({
    to: order.customerEmail,
    ...renderRefund(order, operation.amount, operation.amount >= order.total),
    idempotencyKey: `${message.dedupKey}:customer`,
  });
}
