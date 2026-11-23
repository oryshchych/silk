/**
 * Order emails. Customer-facing copy is site content (Ukrainian and English); every
 * value that came from a person (name, address, branch) is HTML-escaped. Amounts are
 * formatted from integer kopiykas by `formatMoney`.
 */
import { formatMoney, money, type Money } from '@store/shared/money';

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
  items: { name: string; size: string; color: string; quantity: number; lineTotal: Money }[];
  subtotal: Money;
  discountTotal: Money;
  shippingTotal: Money;
  /** Manual correction from the admin (can be negative). */
  adjustmentTotal: Money;
  total: Money;
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
export const oneLine = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

export const escapeHtml = (value: string): string =>
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

/**
 * Colours of the email, light and dark. Text on a coloured ground, never an image that could
 * vanish: the wordmark is TEXT, so it stays readable when a client inverts or darkens the page.
 * The pairs are checked for contrast in the unit tests (WCAG AA, 4.5:1).
 */
export const PALETTE = {
  light: { page: '#f6f4f1', card: '#ffffff', text: '#1a1a1a', muted: '#555555', link: '#7a2e4a' },
  dark: { page: '#121212', card: '#1e1e1e', text: '#ececec', muted: '#b5b5b5', link: '#f0a3c0' },
} as const;

/** The shop name is a placeholder until the owner decides (OWNER_QUEUE Q1). */
const WORDMARK = 'LACE & SILK';

/**
 * The common frame of every email. It declares both colour schemes (`color-scheme` meta and CSS,
 * so a client that honours them does not invert our colours), gives the light colours inline (the
 * safe default for clients that strip `<style>`), and overrides them in a dark media query. The
 * Outlook.com dark mode attributes (`data-ogsc`, `data-ogsb`) get the same overrides.
 */
export function shell(options: { lang: EmailLocale; title: string; content: string }): string {
  const { light, dark } = PALETTE;
  return [
    `<!doctype html><html lang="${options.lang}"><head>`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(options.title)}</title>`,
    '<style>',
    ':root{color-scheme:light dark;supported-color-schemes:light dark}',
    `body{margin:0;padding:0;background:${light.page};color:${light.text}}`,
    `a{color:${light.link}}`,
    '@media (prefers-color-scheme: dark){',
    `body,.page{background:${dark.page}!important;color:${dark.text}!important}`,
    `.card{background:${dark.card}!important;color:${dark.text}!important}`,
    `.brand,a{color:${dark.link}!important}`,
    `.muted{color:${dark.muted}!important}`,
    '}',
    `[data-ogsc] .card,[data-ogsc] body{color:${dark.text}!important}`,
    `[data-ogsb] .card{background:${dark.card}!important}`,
    `[data-ogsb] .page{background:${dark.page}!important}`,
    `[data-ogsc] .brand,[data-ogsc] a{color:${dark.link}!important}`,
    `[data-ogsc] .muted{color:${dark.muted}!important}`,
    '</style></head>',
    `<body class="page" style="margin:0;padding:16px;background:${light.page};color:${light.text};font-family:sans-serif">`,
    `<div class="card" style="max-width:600px;margin:0 auto;padding:24px;background:${light.card};color:${light.text}">`,
    `<p class="brand" style="margin:0 0 16px;font-size:20px;font-weight:bold;letter-spacing:2px;color:${light.link}">${escapeHtml(WORDMARK)}</p>`,
    options.content,
    '</div></body></html>',
  ].join('');
}

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
  const fmt = (amount: Money): string => formatMoney(amount, order.locale);
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
  const content = [
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
  ].join('');
  const html = shell({
    lang: order.locale,
    title: c.subject(order.orderNumber),
    content,
  });
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
