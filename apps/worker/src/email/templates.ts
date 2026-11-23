/**
 * Order emails. Customer-facing copy is site content (Ukrainian and English); every
 * value that came from a person (name, address, branch) is HTML-escaped. Amounts are
 * formatted from integer kopiykas by `formatMoney`.
 */
import { formatMoney, money } from '@store/shared/money';

export type EmailLocale = 'uk' | 'en';

export interface EmailOrder {
  orderNumber: string;
  locale: EmailLocale;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** Human-readable delivery line, already composed (method, city, branch or address). */
  deliveryLine: string;
  paymentLabel: string;
  items: { name: string; size: string; color: string; quantity: number; lineTotal: number }[];
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  /** Manual correction from the admin (can be negative). */
  adjustmentTotal: number;
  total: number;
  /** Absolute address of the tracking page. */
  trackUrl: string;
  paymentProvider: string | null;
  /** Order status at send time: a cancelled order gets no "thank you". */
  status: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Control characters (line breaks, tabs, NUL) become a space: a buyer's text stays on one line. */
const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

const COPY = {
  uk: {
    subject: (n: string) => `Замовлення ${n} оформлено`,
    hello: (name: string) => `Вітаємо, ${name}!`,
    thanks: 'Дякуємо за замовлення. Ми вже працюємо над ним.',
    cod: 'Менеджер зателефонує для підтвердження. Ви платите під час отримання.',
    transfer: 'Реквізити для оплати надішлемо окремим листом. Замовлення тримаємо 24 години.',
    number: 'Номер замовлення',
    items: 'Товари',
    delivery: 'Доставка',
    payment: 'Оплата',
    subtotal: 'Товари',
    discount: 'Знижка',
    shipping: 'Доставка',
    total: 'Разом',
    adjustment: 'Коригування',
    track: 'Відстежити замовлення (потрібні номер і телефон)',
    notYou: 'Якщо ви не оформлювали це замовлення, просто проігноруйте цей лист.',
    adminSubject: (n: string, total: string) => `Нове замовлення ${n} на ${total}`,
    customer: 'Покупець',
  },
  en: {
    subject: (n: string) => `Order ${n} placed`,
    hello: (name: string) => `Hello, ${name}!`,
    thanks: 'Thank you for your order. We are already working on it.',
    cod: 'A manager will call to confirm. You pay when you receive the parcel.',
    transfer:
      'We will send the payment details in a separate email. The order is held for 24 hours.',
    number: 'Order number',
    items: 'Items',
    delivery: 'Delivery',
    payment: 'Payment',
    subtotal: 'Items',
    discount: 'Discount',
    shipping: 'Delivery',
    total: 'Total',
    adjustment: 'Adjustment',
    track: 'Track your order (order number and phone needed)',
    notYou: 'If you did not place this order, simply ignore this email.',
    adminSubject: (n: string, total: string) => `New order ${n} for ${total}`,
    customer: 'Customer',
  },
} as const;

function body(order: EmailOrder, audience: 'customer' | 'admin'): { html: string; text: string } {
  const c = COPY[order.locale];
  const fmt = (kopiykas: number): string => formatMoney(money(kopiykas), order.locale);
  const next =
    order.paymentProvider === 'cod'
      ? c.cod
      : order.paymentProvider === 'bank_transfer'
        ? c.transfer
        : '';
  const lines = order.items.map(
    (item) =>
      `${item.name}, ${item.color}, ${item.size} x ${String(item.quantity)}: ${fmt(item.lineTotal)}`,
  );
  const totals = [
    `${c.subtotal}: ${fmt(order.subtotal)}`,
    ...(order.discountTotal > 0 ? [`${c.discount}: -${fmt(order.discountTotal)}`] : []),
    `${c.shipping}: ${fmt(order.shippingTotal)}`,
    ...(order.adjustmentTotal === 0 ? [] : [`${c.adjustment}: ${fmt(order.adjustmentTotal)}`]),
    `${c.total}: ${fmt(order.total)}`,
  ];
  const contact =
    audience === 'admin'
      ? [`${c.customer}: ${order.customerName}, ${order.customerPhone}, ${order.customerEmail}`]
      : [];
  const head = audience === 'customer' ? [c.hello(order.customerName), c.thanks] : [];
  const text = [
    ...head,
    `${c.number}: ${order.orderNumber}`,
    ...contact,
    '',
    c.items,
    ...lines,
    '',
    `${c.delivery}: ${order.deliveryLine}`,
    `${c.payment}: ${order.paymentLabel}`,
    ...(audience === 'customer' && next !== '' ? ['', next] : []),
    '',
    ...totals,
    ...(audience === 'customer' ? ['', `${c.track}: ${order.trackUrl}`, '', c.notYou] : []),
  ].join('\n');

  const li = (value: string): string => `<li>${escapeHtml(value)}</li>`;
  const html = [
    '<!doctype html><html><body style="font-family:sans-serif;color:#1a1a1a">',
    ...(audience === 'customer'
      ? [`<h1>${escapeHtml(c.hello(order.customerName))}</h1>`, `<p>${escapeHtml(c.thanks)}</p>`]
      : []),
    `<p><strong>${escapeHtml(c.number)}:</strong> ${escapeHtml(order.orderNumber)}</p>`,
    ...contact.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<h2>${escapeHtml(c.items)}</h2>`,
    `<ul>${lines.map(li).join('')}</ul>`,
    `<p><strong>${escapeHtml(c.delivery)}:</strong> ${escapeHtml(order.deliveryLine)}</p>`,
    `<p><strong>${escapeHtml(c.payment)}:</strong> ${escapeHtml(order.paymentLabel)}</p>`,
    ...(audience === 'customer' && next !== '' ? [`<p>${escapeHtml(next)}</p>`] : []),
    `<ul>${totals.map(li).join('')}</ul>`,
    ...(audience === 'customer'
      ? [
          `<p><a href="${escapeHtml(order.trackUrl)}">${escapeHtml(c.track)}</a></p>`,
          `<p>${escapeHtml(c.notYou)}</p>`,
        ]
      : []),
    '</body></html>',
  ].join('');
  return { html, text };
}

function clean(order: EmailOrder): EmailOrder {
  return {
    ...order,
    customerName: oneLine(order.customerName),
    deliveryLine: oneLine(order.deliveryLine),
  };
}

export function renderCustomerEmail(input: EmailOrder): RenderedEmail {
  const order = clean(input);
  return { subject: COPY[order.locale].subject(order.orderNumber), ...body(order, 'customer') };
}

/** The shop's own notification is always in Ukrainian: the staff reads it, not the buyer. */
export function renderAdminEmail(input: EmailOrder): RenderedEmail {
  const order = clean(input);
  const staff: EmailOrder = { ...order, locale: 'uk' };
  const total = formatMoney(money(order.total), 'uk');
  return {
    subject: COPY.uk.adminSubject(order.orderNumber, total),
    ...body(staff, 'admin'),
  };
}
