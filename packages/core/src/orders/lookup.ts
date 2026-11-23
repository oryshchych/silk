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
import { customerOrderDto, type CustomerOrderDto } from '@store/shared/dto/order';
import { serialize } from '@store/shared/dto/serialize';

const ORDER_NUMBER = /^[A-Z]{2}-\d{4}-\d{6}$/;

export const normalizeOrderNumber = (raw: string): string | null => {
  const value = raw.trim().toUpperCase();
  return ORDER_NUMBER.test(value) ? value : null;
};

async function loadDto(
  reader: Reader,
  order: typeof orders.$inferSelect,
): Promise<CustomerOrderDto> {
  const items = await reader
    .select({
      name: orderItems.nameSnapshot,
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
  return serialize(customerOrderDto, {
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
  });
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
  return order === undefined ? null : await loadDto(reader, order);
}

/** The order for a number and the exact phone (already normalised) it was placed with, or null. */
export async function findOrderForTracking(
  reader: Reader,
  orderNumber: string,
  phone: string,
): Promise<CustomerOrderDto | null> {
  const number = normalizeOrderNumber(orderNumber);
  if (number === null) return null;
  const [order] = await reader
    .select()
    .from(orders)
    .where(and(eq(orders.orderNumber, number), eq(orders.customerPhone, phone)));
  return order === undefined ? null : await loadDto(reader, order);
}
