/**
 * The customer's own orders. EVERY query is scoped by the customer id of the SESSION (never by an
 * id from the request): another customer's order number answers exactly like a number that does
 * not exist. The DTOs list their fields explicitly (no cost snapshot, no admin note).
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { cartItems, carts, orderItems, orders, productVariants, products } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { accountOrderRowDto, type AccountOrderRowDto } from '@store/shared/dto/account';
import { customerOrderDto, type CustomerOrderDto } from '@store/shared/dto/order';
import { serialize } from '@store/shared/dto/serialize';

import { setCartItem } from '../cart/cart.ts';
import { normalizeOrderNumber } from '../orders/lookup.ts';

const PAGE = 50;

export async function listMyOrders(
  reader: Reader,
  customerId: string,
): Promise<AccountOrderRowDto[]> {
  const rows = await reader
    .select({
      orderNumber: orders.orderNumber,
      createdAt: orders.createdAt,
      status: orders.status,
      total: orders.total,
      itemCount: sql<number>`coalesce((SELECT sum(quantity) FROM order_items i WHERE i.order_id = ${orders.id}), 0)::int`,
    })
    .from(orders)
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(PAGE);
  return rows.map((row) =>
    serialize(accountOrderRowDto, { ...row, createdAt: row.createdAt.toISOString() }),
  );
}

export async function getMyOrder(
  reader: Reader,
  customerId: string,
  orderNumber: string,
): Promise<CustomerOrderDto | null> {
  const number = normalizeOrderNumber(orderNumber);
  if (number === null) return null;
  const [order] = await reader
    .select()
    .from(orders)
    .where(and(eq(orders.orderNumber, number), eq(orders.customerId, customerId)));
  if (order === undefined) return null;
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

export interface ReorderResult {
  added: number;
  skipped: number;
}

/**
 * Puts the lines of one of MY orders into the cart behind `cartToken`. The price, the stock and
 * whether a variant still exists are the cart's and checkout's to decide now (the old price is
 * never reused): a variant that is gone or switched off is skipped and counted.
 */
export async function reorderMyOrder(
  tx: Tx,
  input: { customerId: string; orderNumber: string; cartToken: string },
): Promise<ReorderResult | null> {
  const number = normalizeOrderNumber(input.orderNumber);
  if (number === null) return null;
  const [order] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.orderNumber, number), eq(orders.customerId, input.customerId)));
  if (order === undefined) return null;
  const lines = await tx
    .select({
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      live: sql<boolean>`${productVariants.isActive} AND ${products.isActive}`,
    })
    .from(orderItems)
    .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  let added = 0;
  let skipped = 0;
  for (const line of lines) {
    if (line.variantId === null || !line.live) {
      skipped += 1;
      continue;
    }
    // "At least what was ordered", never "plus again": a repeat, a second tab or a retry changes
    // nothing (adding would multiply the quantity up to the cart limit).
    const [existing] = await tx
      .select({ quantity: cartItems.quantity })
      .from(cartItems)
      .innerJoin(carts, eq(carts.id, cartItems.cartId))
      .where(and(eq(carts.token, input.cartToken), eq(cartItems.variantId, line.variantId)));
    await setCartItem(tx, {
      cartToken: input.cartToken,
      variantId: line.variantId,
      quantity: Math.max(existing?.quantity ?? 0, line.quantity),
      mode: 'set',
    });
    added += 1;
  }
  return { added, skipped };
}
