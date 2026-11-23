/**
 * `email.order-created`: loads the order from the database (the outbox payload carries only
 * its id, personal data never sits in the queue), sends the buyer's confirmation and the
 * shop's notification. Each message has its own idempotency key, so a retry after a partial
 * failure sends only what did not go out.
 */
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { orderItems, orders, settings } from '@store/db/schema';
import { add, money } from '@store/shared/money';
import type { Reader } from '@store/db/types';

import type { EmailSender } from './resend.ts';
import { renderAdminEmail, renderCustomerEmail, type EmailOrder } from './templates.ts';

const payload = z.object({ orderId: z.uuid() });

const DELIVERY = {
  uk: {
    np_warehouse: 'Нова пошта, відділення',
    np_courier: 'Нова пошта, кур’єр',
    ukrposhta: 'Укрпошта',
    pickup: 'Самовивіз',
  },
  en: {
    np_warehouse: 'Nova Poshta branch',
    np_courier: 'Nova Poshta courier',
    ukrposhta: 'Ukrposhta',
    pickup: 'Pickup',
  },
} as const;

const PAYMENT = {
  uk: {
    cod: 'Післяплата',
    bank_transfer: 'Банківський переказ',
    mono: 'Картка',
    wayforpay: 'Картка',
    gift_card: 'Сертифікат',
  },
  en: {
    cod: 'Cash on delivery',
    bank_transfer: 'Bank transfer',
    mono: 'Card',
    wayforpay: 'Card',
    gift_card: 'Gift card',
  },
} as const;

export class OrderEmailError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'OrderEmailError';
  }
}

export async function loadEmailOrder(
  reader: Reader,
  orderId: string,
  siteUrl: string,
): Promise<EmailOrder> {
  const [order] = await reader.select().from(orders).where(eq(orders.id, orderId));
  if (order === undefined) throw new OrderEmailError('order not found');
  const items = await reader
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  const locale = order.locale === 'en' ? 'en' : 'uk';
  const methods: Record<string, string> = DELIVERY[locale];
  const payments: Record<string, string> = PAYMENT[locale];
  const prefix = locale === 'en' ? '/en' : '';
  return {
    orderNumber: order.orderNumber,
    locale,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    deliveryLine: [
      methods[order.deliveryMethod] ?? order.deliveryMethod,
      order.deliverySettlementName,
      order.deliveryWarehouseName,
      order.deliveryAddress,
    ]
      .filter((part): part is string => part !== null && part !== '')
      .join(', '),
    paymentLabel: payments[order.paymentProvider ?? ''] ?? '',
    paymentProvider: order.paymentProvider,
    status: order.status,
    items: items.map((item) => ({
      name: item.nameSnapshot,
      size: item.sizeLabel,
      color: item.colorName,
      quantity: item.quantity,
      // Gross: the order total lists the discount once, so each line is shown before it.
      lineTotal: add(money(item.lineTotal), money(item.lineDiscount)),
    })),
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    shippingTotal: order.shippingTotal,
    adjustmentTotal: order.adjustmentTotal,
    total: order.total,
    trackUrl: `${siteUrl.replace(/\/+$/, '')}${prefix}/order/track`,
  };
}

/** The shop's notification address: `settings.contacts.email`; none configured means no staff mail. */
async function staffAddress(reader: Reader): Promise<string | null> {
  const [row] = await reader.select().from(settings).where(eq(settings.key, 'contacts'));
  const value: unknown = row?.value;
  if (typeof value !== 'object' || value === null || !('email' in value)) return null;
  // One plain address: a list, a display name or anything else is not a recipient (the setting is
  // editable text, and whoever can edit it would otherwise choose who receives every order).
  const parsed = z.email().safeParse(value.email);
  return parsed.success ? parsed.data : null;
}

export async function handleOrderCreated(
  deps: { reader: Reader; sender: EmailSender; siteUrl: string },
  message: { dedupKey: string; payload: unknown },
): Promise<void> {
  const parsed = payload.safeParse(message.payload);
  if (!parsed.success) throw new OrderEmailError('malformed payload');
  const order = await loadEmailOrder(deps.reader, parsed.data.orderId, deps.siteUrl);

  // After a long outage the order may already be expired or cancelled: no "thank you" then.
  if (order.status === 'cancelled') return;
  const customer = renderCustomerEmail(order);
  await deps.sender.send({
    to: order.customerEmail,
    ...customer,
    idempotencyKey: `${message.dedupKey}:customer`,
  });
  const staff = await staffAddress(deps.reader);
  if (staff !== null) {
    await deps.sender.send({
      to: staff,
      ...renderAdminEmail(order),
      idempotencyKey: `${message.dedupKey}:admin`,
    });
  }
}
