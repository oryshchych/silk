/**
 * Order reads for the buyer: the success page (access token from the cookie
 * set at checkout) and the tracking form (order number plus the phone it was
 * placed with). Both answer with the customer DTO only (AGENTS.md 4b.3), and
 * both treat "no such order" and "wrong secret" the same.
 */
import { createHash } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { orderItems, orders } from '@store/db/schema';
import type { Reader } from '@store/db/types';
import {
  customerOrderDto,
  trackedOrderDto,
  type CustomerOrderDto,
  type TrackedOrderDto,
} from '@store/shared/dto/order';
import { serialize } from '@store/shared/dto/serialize';

const ORDER_NUMBER = /^[A-Z]{2}-\d{4}-\d{6}$/;

export const normalizeOrderNumber = (raw: string): string | null => {
  const value = raw.trim().toUpperCase();
  return ORDER_NUMBER.test(value) ? value : null;
};

async function loadView(reader: Reader, order: typeof orders.$inferSelect) {
  const items = await reader
    .select({
      name: orderItems.nameSnapshot,
      productId: orderItems.productId,
      sku: orderItems.skuSnapshot,
      sizeLabel: orderItems.sizeLabel,
      colorName: orderItems.colorName,
      unitPrice: orderItems.unitPrice,
      quantity: orderItems.quantity,
      lineDiscount: orderItems.lineDiscount,
      lineTotal: orderItems.lineTotal,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  return {
    orderNumber: order.orderNumber,
    paymentProvider: order.paymentProvider,
    deliveryMethod: order.deliveryMethod,
    deliveryCity: order.deliverySettlementName,
    deliveryPoint: order.deliveryWarehouseName,
    deliveryAddress: order.deliveryAddress,
    status: order.status,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt.toISOString(),
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    shippingTotal: order.shippingTotal,
    total: order.total,
    ttn: order.ttn,
    items,
  };
}

/** The order for a number and its access token (stored as a SHA-256 hash), or null. */
export async function getOrderByAccessToken(
  reader: Reader,
  orderNumber: string,
  accessToken: string,
): Promise<CustomerOrderDto | null> {
  const number = normalizeOrderNumber(orderNumber);
  if (number === null || accessToken === '' || accessToken.length > 200) return null;
  const hash = createHash('sha256').update(accessToken).digest('hex');
  const [order] = await reader
    .select()
    .from(orders)
    .where(and(eq(orders.orderNumber, number), eq(orders.accessTokenHash, hash)));
  return order === undefined ? null : serialize(customerOrderDto, await loadView(reader, order));
}

/** The order for a number and the exact phone (already normalised) it was placed with, or null. */
export async function findOrderForTracking(
  reader: Reader,
  orderNumber: string,
  phone: string,
): Promise<TrackedOrderDto | null> {
  const number = normalizeOrderNumber(orderNumber);
  if (number === null) return null;
  const [order] = await reader
    .select()
    .from(orders)
    .where(and(eq(orders.orderNumber, number), eq(orders.customerPhone, phone)));
  // Reduced view: no street address, no waybill (see trackedOrderDto).
  return order === undefined ? null : serialize(trackedOrderDto, await loadView(reader, order));
}

export interface PayableOrder {
  id: string;
  orderNumber: string;
  paymentProvider: typeof orders.$inferSelect.paymentProvider;
  paymentStatus: typeof orders.$inferSelect.paymentStatus;
  status: typeof orders.$inferSelect.status;
}

/**
 * The order a browser may start a payment for: the number AND its access token (stored as a
 * SHA-256 hash), compared in SQL. "No such order" and "wrong token" are the same `null`.
 */
export async function resolveOrderForPayment(
  reader: Reader,
  orderNumber: string,
  accessToken: string,
): Promise<PayableOrder | null> {
  const number = normalizeOrderNumber(orderNumber);
  if (number === null || accessToken === '' || accessToken.length > 200) return null;
  const hash = createHash('sha256').update(accessToken).digest('hex');
  const [order] = await reader
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      paymentProvider: orders.paymentProvider,
      paymentStatus: orders.paymentStatus,
      status: orders.status,
    })
    .from(orders)
    .where(and(eq(orders.orderNumber, number), eq(orders.accessTokenHash, hash)));
  return order ?? null;
}
