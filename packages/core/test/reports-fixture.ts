/**
 * A small builder for report tests: one order with its lines, captures, refunds and returns at
 * EXPLICIT instants, written straight into the tables (no checkout), so every figure a test expects
 * is computed by hand from numbers it can see.
 */
import { randomUUID } from 'node:crypto';

import {
  orderItems,
  orders,
  paymentAttempts,
  refundOperations,
  returnRequestItems,
  returnRequests,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';

export interface LineSpec {
  uid?: string;
  name?: string;
  category?: string;
  quantity: number;
  /** Unit price in kopiykas. */
  price: number;
  discount?: number;
  /** Unit cost in kopiykas; `null` = no cost snapshot. */
  cost: number | null;
}

export interface CaptureSpec {
  at: string | null;
  amount: number;
  provider?: 'mono' | 'wayforpay' | 'bank_transfer' | 'gift_card' | 'cod';
}

export interface RefundSpec {
  at: string | null;
  amount: number;
  state?: 'succeeded' | 'pending' | 'failed' | 'unknown' | 'in_flight';
  /** Index into `captures`. */
  capture?: number;
  returnIndex?: number;
}

export interface ReturnSpec {
  receivedAt: string | null;
  /** Per line index: received and restocked units. */
  items: { line: number; received: number; restocked: number }[];
  reason?: 'defect' | 'changed_mind' | 'wrong_size' | 'wrong_item' | 'not_as_described' | 'other';
  createdAt?: string;
}

export interface OrderSpec {
  createdAt?: string;
  status?: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled' | 'returned';
  provider?: 'mono' | 'wayforpay' | 'bank_transfer' | 'cod' | 'gift_card' | null;
  delivery?: 'np_warehouse' | 'np_courier' | 'ukrposhta' | 'pickup';
  lines: LineSpec[];
  shippingTotal?: number;
  shippingPaidBy?: 'sender' | 'recipient';
  shippingCostActual?: number | null;
  cancelledAt?: string | null;
  promoCode?: string | null;
  email?: string;
  customerId?: string | null;
  captures?: CaptureSpec[];
  refunds?: RefundSpec[];
  returns?: ReturnSpec[];
}

const nextNumber = (): string => `LS-T-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const at = (value: string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

const createdAtOf = (value: string | null | undefined): { createdAt?: Date } =>
  value === null || value === undefined ? {} : { createdAt: new Date(value) };

export interface InsertedOrder {
  orderId: string;
  lineIds: string[];
  attemptIds: string[];
}

export async function insertOrder(tx: Tx, spec: OrderSpec): Promise<InsertedOrder> {
  const subtotalLines = spec.lines.map((l) => l.price * l.quantity);
  const lineDiscount = spec.lines.map((l) => l.discount ?? 0);
  const subtotal = subtotalLines.reduce((a, b) => a + b, 0);
  const discount = lineDiscount.reduce((a, b) => a + b, 0);
  const shipping = spec.shippingTotal ?? 0;
  const total = subtotal - discount + shipping;
  const captures = spec.captures ?? [];
  const captured = captures.reduce(
    (sum, c) => sum + (c.provider === 'gift_card' ? 0 : c.amount),
    0,
  );
  const refundedSucceeded = (spec.refunds ?? [])
    .filter((r) => (r.state ?? 'succeeded') === 'succeeded')
    .reduce((sum, r) => sum + r.amount, 0);
  const [order] = await tx
    .insert(orders)
    .values({
      orderNumber: nextNumber(),
      customerId: spec.customerId ?? null,
      status: spec.status ?? 'confirmed',
      paymentStatus: captured > 0 ? 'paid' : 'pending',
      paymentProvider: spec.provider === undefined ? 'mono' : spec.provider,
      customerEmail: spec.email ?? `buyer-${randomUUID().slice(0, 8)}@example.com`,
      customerPhone: '+380501112233',
      customerName: 'Test Buyer',
      deliveryMethod: spec.delivery ?? 'np_warehouse',
      subtotal,
      discountTotal: discount,
      shippingTotal: shipping,
      total,
      capturedTotal: captured,
      refundedTotal: Math.min(refundedSucceeded, captured),
      shippingCostActual: spec.shippingCostActual ?? null,
      shippingPaidBy: spec.shippingPaidBy ?? 'recipient',
      promoCode: spec.promoCode ?? null,
      cancelledAt: at(spec.cancelledAt),
      ...(spec.createdAt === undefined ? {} : { createdAt: new Date(spec.createdAt) }),
    })
    .returning({ id: orders.id });
  if (order === undefined) throw new Error('fixture: order');
  const lineIds: string[] = [];
  for (const [index, line] of spec.lines.entries()) {
    const [row] = await tx
      .insert(orderItems)
      .values({
        orderId: order.id,
        productUidSnapshot: line.uid ?? randomUUID(),
        variantUidSnapshot: randomUUID(),
        nameSnapshot: line.name ?? `Product ${String(index + 1)}`,
        skuSnapshot: `SKU-${String(index + 1)}`,
        sizeLabel: 'M',
        colorName: 'Black',
        categoryPathSnapshot: line.category ?? 'Bras',
        unitPrice: line.price,
        lineDiscount: line.discount ?? 0,
        unitCostSnapshot: line.cost,
        quantity: line.quantity,
        lineTotal: line.price * line.quantity - (line.discount ?? 0),
      })
      .returning({ id: orderItems.id });
    if (row === undefined) throw new Error('fixture: line');
    lineIds.push(row.id);
  }
  const attemptIds: string[] = [];
  for (const [index, capture] of captures.entries()) {
    const [row] = await tx
      .insert(paymentAttempts)
      .values({
        orderId: order.id,
        attemptNumber: index + 1,
        provider: capture.provider ?? 'mono',
        state: 'succeeded',
        status: 'paid',
        amount: capture.amount,
        capturedAmount: capture.amount,
        completedAt: at(capture.at),
        ...createdAtOf(capture.at ?? spec.createdAt),
      })
      .returning({ id: paymentAttempts.id });
    if (row === undefined) throw new Error('fixture: attempt');
    attemptIds.push(row.id);
  }
  const returnIds: string[] = [];
  for (const [index, ret] of (spec.returns ?? []).entries()) {
    const [row] = await tx
      .insert(returnRequests)
      .values({
        requestNumber: `RT-${randomUUID().slice(0, 12)}`,
        orderId: order.id,
        status: ret.receivedAt === null ? 'approved' : 'received',
        reason: ret.reason ?? 'changed_mind',
        policyVersion: 'test',
        receivedAt: at(ret.receivedAt),
        ...createdAtOf(ret.createdAt ?? spec.createdAt),
      })
      .returning({ id: returnRequests.id });
    if (row === undefined) throw new Error(`fixture: return ${String(index)}`);
    returnIds.push(row.id);
    for (const item of ret.items) {
      const lineId = lineIds[item.line];
      if (lineId === undefined) throw new Error('fixture: return line');
      await tx.insert(returnRequestItems).values({
        returnRequestId: row.id,
        orderItemId: lineId,
        orderId: order.id,
        quantity: Math.max(item.received, 1),
        receivedQuantity: item.received,
        restockedQuantity: item.restocked,
      });
    }
  }
  for (const refund of spec.refunds ?? []) {
    const attemptId = attemptIds[refund.capture ?? 0];
    const returnRequestId = refund.returnIndex === undefined ? null : returnIds[refund.returnIndex];
    await tx.insert(refundOperations).values({
      orderId: order.id,
      paymentAttemptId: attemptId ?? null,
      returnRequestId: returnRequestId ?? null,
      amount: refund.amount,
      state: refund.state ?? 'succeeded',
      settledAt: at(refund.at),
      ...createdAtOf(refund.at ?? spec.createdAt),
    });
  }
  return { orderId: order.id, lineIds, attemptIds };
}
