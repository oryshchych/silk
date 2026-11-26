/**
 * Nova Poshta waybills from the admin (phase 5), as three steps that never share a transaction
 * with the carrier call (ADR-4 for external effects):
 *
 *   1. `beginWaybill`  (tx): checks the order, records an `in_flight` shipment operation with the
 *      request snapshot, COMMITS. The partial unique index `shipment_one_live_uq` allows one live
 *      operation per order, so a second click or a second tab cannot start a second call.
 *   2. the carrier call, no transaction open (the caller does it).
 *   3. `completeWaybill` (tx): the carrier's answer settles the operation. Success stores the
 *      number and the REAL tariff on the order, writes the history row and the buyer's email into
 *      the outbox, in one transaction. A refusal frees the order for another try. An unknown
 *      result keeps the operation live: `InternetDocument/save` has no idempotency key, so the
 *      document may exist, and only a person (`resolveWaybill`) closes it, with the number from
 *      the carrier's portal or the confirmation that nothing was made.
 *
 * Lock order (ADR-22): orders (3) only.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';

import {
  orderItems,
  orderStatusHistory,
  orders,
  outbox,
  productVariants,
  products,
  settings,
  shipmentOperations,
} from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { isWaybillNumber, type WaybillRequest, type WaybillResult } from '@store/payments/shipping';
import { money, subtract } from '@store/shared/money';

import { AdminNotFoundError } from '../catalog-admin/errors.ts';
import {
  WaybillInProgressError,
  WaybillNotAllowedError,
  WaybillNotConfiguredError,
} from '../errors.ts';
import { heldRefundTotal } from '../orders/fulfilment.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { ADMIN_SOURCE } from '../orders-admin/workflow.ts';

const LIVE = ['pending', 'in_flight', 'unknown', 'succeeded'] as const;
const FALLBACK_WEIGHT_GRAMS = 200;

export interface SenderProfile {
  cityRef: string;
  senderRef: string;
  contactRef: string;
  addressRef: string;
  phone: string;
}

/** `settings.np_sender`: the shop's own refs in the carrier's system, set by the owner (Q2). */
async function senderProfile(tx: Tx): Promise<SenderProfile> {
  const [row] = await tx.select().from(settings).where(eq(settings.key, 'np_sender'));
  const raw: unknown = row?.value;
  if (typeof raw !== 'object' || raw === null) throw new WaybillNotConfiguredError();
  const value: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const field = (key: string): string => {
    const found = value[key];
    if (typeof found !== 'string' || found === '') throw new WaybillNotConfiguredError();
    return found;
  };
  return {
    cityRef: field('cityRef'),
    senderRef: field('senderRef'),
    contactRef: field('contactRef'),
    addressRef: field('addressRef'),
    phone: field('phone'),
  };
}

/** The carrier wants a first and a last name; a one-word name is sent back to the manager. */
export function splitName(full: string): { firstName: string; lastName: string } | null {
  const parts = full
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  const [first, second] = parts;
  if (first === undefined || second === undefined) return null;
  // The shop's checkout takes one free "name" field; "Last First ..." and "First Last" both occur,
  // so the manager checks the document before it is printed. First word as the last name is the
  // Ukrainian document order.
  return { lastName: first, firstName: second };
}

const kyivDay = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

export interface BegunWaybill {
  operationId: string;
  request: WaybillRequest;
}

export async function beginWaybill(tx: Tx, input: { orderId: string }): Promise<BegunWaybill> {
  await acquireLocks(tx, { orders: [input.orderId] });
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (order === undefined) throw new AdminNotFoundError('order');
  if (order.deliveryMethod !== 'np_warehouse' && order.deliveryMethod !== 'np_courier') {
    throw new WaybillNotAllowedError('not a Nova Poshta order');
  }
  if (order.status !== 'confirmed' && order.status !== 'processing') {
    throw new WaybillNotAllowedError(`the order is ${order.status}`);
  }
  if (order.ttn !== null) throw new WaybillNotAllowedError('the order already has a waybill');
  // The same rule as shipping: money that was returned (or is being) is not money the order holds.
  const isCod = order.paymentProvider === 'cod';
  if (!isCod) {
    if (order.paymentStatus !== 'paid') throw new WaybillNotAllowedError('the order is not paid');
    const held = await heldRefundTotal(tx, order.id);
    if (order.capturedTotal - held < order.total) {
      throw new WaybillNotAllowedError('a refund covers part of the captured amount');
    }
  }
  // Cash on delivery: the carrier collects what the buyer still owes (anything already paid, a gift
  // card or a part payment, is not collected again).
  const toCollect = order.total - order.capturedTotal;
  if (toCollect < 0) throw new WaybillNotAllowedError('more was received than the order costs');
  const live = await tx
    .select({ state: shipmentOperations.state })
    .from(shipmentOperations)
    .where(
      and(eq(shipmentOperations.orderId, order.id), inArray(shipmentOperations.state, [...LIVE])),
    );
  if (live.some((row) => row.state === 'succeeded')) {
    throw new WaybillNotAllowedError('the order already has a waybill');
  }
  if (live.length > 0) throw new WaybillInProgressError();

  const sender = await senderProfile(tx);
  const recipient = splitName(order.customerName);
  if (recipient === null)
    throw new WaybillNotAllowedError('the recipient needs a first and a last name');
  if (order.deliverySettlementRef === null) {
    throw new WaybillNotAllowedError('the order has no destination city');
  }
  const warehouseRef = order.deliveryMethod === 'np_warehouse' ? order.deliveryWarehouseRef : null;
  if (order.deliveryMethod === 'np_warehouse' && warehouseRef === null) {
    throw new WaybillNotAllowedError('the order has no branch');
  }
  if (order.deliveryMethod === 'np_courier' && order.deliveryAddress === null) {
    throw new WaybillNotAllowedError('the order has no street address');
  }

  const lines = await tx
    .select({
      quantity: orderItems.quantity,
      productWeight: products.weightGrams,
      variantWeight: productVariants.weightGrams,
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
    .where(eq(orderItems.orderId, order.id));
  const weightGrams = lines.reduce(
    (total, line) =>
      total + line.quantity * (line.variantWeight ?? line.productWeight ?? FALLBACK_WEIGHT_GRAMS),
    0,
  );
  const request: WaybillRequest = {
    localReference: '',
    sender,
    recipient: {
      ...recipient,
      phone: order.customerPhone,
      cityRef: order.deliverySettlementRef,
      warehouseRef,
      address: order.deliveryAddress,
    },
    weightGrams,
    // The declared value is the goods the buyer pays for, after the discount.
    declaredCost: subtract(money(order.subtotal), money(order.discountTotal)),
    description: 'Одяг',
    payer: order.shippingPaidBy === 'sender' ? 'sender' : 'recipient',
    cashOnDelivery: isCod && toCollect > 0 ? money(toCollect) : null,
    day: kyivDay(),
  };
  const [operation] = await tx
    .insert(shipmentOperations)
    .values({
      orderId: order.id,
      carrier: 'nova_poshta',
      state: 'in_flight',
      declaredCost: request.declaredCost,
      weightGrams,
      requestSnapshot: { ...request, sender: undefined },
    })
    .returning({ id: shipmentOperations.id, localReference: shipmentOperations.localReference });
  if (operation === undefined) throw new Error('shipment operation insert returned no row');
  return {
    operationId: operation.id,
    request: { ...request, localReference: operation.localReference },
  };
}

export interface CompletedWaybill {
  state: 'succeeded' | 'failed' | 'unknown';
  /** False when an earlier call already settled the operation. */
  changed: boolean;
  ttn: string | null;
}

/** Settles an `in_flight` operation with the carrier's answer, in one transaction. Idempotent. */
export async function completeWaybill(
  tx: Tx,
  input: { operationId: string; result: WaybillResult; actorUserId: string | null },
): Promise<CompletedWaybill> {
  const [probe] = await tx
    .select({ orderId: shipmentOperations.orderId })
    .from(shipmentOperations)
    .where(eq(shipmentOperations.id, input.operationId));
  if (probe === undefined) throw new WaybillNotAllowedError('no such operation');
  await acquireLocks(tx, { orders: [probe.orderId] });
  const [operation] = await tx
    .select()
    .from(shipmentOperations)
    .where(eq(shipmentOperations.id, input.operationId));
  if (operation === undefined) throw new WaybillNotAllowedError('no such operation');
  if (operation.state !== 'in_flight') {
    return {
      state:
        operation.state === 'succeeded' || operation.state === 'unknown'
          ? operation.state
          : 'failed',
      changed: false,
      ttn: operation.ttn,
    };
  }
  const { result } = input;
  if (result.state !== 'succeeded') {
    await tx
      .update(shipmentOperations)
      .set({ state: result.state, lastError: result.error.slice(0, 200) })
      .where(eq(shipmentOperations.id, operation.id));
    return { state: result.state, changed: true, ttn: null };
  }
  await tx
    .update(shipmentOperations)
    .set({
      state: 'succeeded',
      providerDocumentRef: result.documentRef,
      ttn: result.ttn,
      quotedCost: result.cost,
      responseSnapshot: { documentRef: result.documentRef, ttn: result.ttn, cost: result.cost },
      lastError: null,
    })
    .where(eq(shipmentOperations.id, operation.id));
  // The order may have changed while the call was out (nothing cancels an order with a live waybill
  // any more, but the check is cheap and the cost of being wrong is a parcel for a cancelled
  // order): settle the operation, tell nobody outside, raise an alert for the owner.
  const [current] = await tx
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, operation.orderId));
  const cancelled = current?.status === 'cancelled';
  await recordWaybill(tx, {
    orderId: operation.orderId,
    ttn: result.ttn,
    cost: result.cost,
    actorUserId: input.actorUserId,
    comment: cancelled ? 'created at the carrier for a cancelled order' : 'created at the carrier',
    notify: !cancelled,
  });
  if (cancelled) {
    await tx
      .insert(outbox)
      .values({
        topic: 'alert.waybill-for-cancelled-order',
        payload: { orderId: operation.orderId },
        dedupKey: `waybill-cancelled:${operation.orderId}`,
      })
      .onConflictDoNothing();
  }
  return { state: 'succeeded', changed: true, ttn: result.ttn };
}

async function recordWaybill(
  tx: Tx,
  input: {
    orderId: string;
    ttn: string;
    cost: number | null;
    actorUserId: string | null;
    comment: string;
    /** Tell the buyer (the email goes through the outbox); false for a cancelled order. */
    notify: boolean;
  },
): Promise<void> {
  await tx
    .update(orders)
    .set({ ttn: input.ttn, ...(input.cost === null ? {} : { shippingCostActual: input.cost }) })
    .where(eq(orders.id, input.orderId));
  await tx.insert(orderStatusHistory).values({
    orderId: input.orderId,
    fromStatus: null,
    toStatus: 'waybill',
    field: 'ttn',
    changedByUserId: input.actorUserId,
    source: ADMIN_SOURCE,
    comment: input.comment,
  });
  if (!input.notify) return;
  await tx
    .insert(outbox)
    .values({
      topic: 'email.waybill-created',
      payload: { orderId: input.orderId },
      dedupKey: `waybill:${input.orderId}`,
    })
    .onConflictDoNothing();
}

export type WaybillResolution =
  /** The document exists at the carrier: the number is taken from the carrier's portal. */
  | { kind: 'attach'; ttn: string }
  /** The carrier confirmed that no document was made: the order may be tried again. */
  | { kind: 'none' };

/** A person closes an `in_flight` or `unknown` operation after checking with the carrier. */
export async function resolveWaybill(
  tx: Tx,
  input: { orderId: string; resolution: WaybillResolution; actorUserId: string },
): Promise<{ changed: boolean; ttn: string | null }> {
  await acquireLocks(tx, { orders: [input.orderId] });
  const [open] = await tx
    .select()
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.orderId, input.orderId),
        inArray(shipmentOperations.state, ['pending', 'in_flight', 'unknown']),
      ),
    );
  if (open === undefined) return { changed: false, ttn: null };
  if (input.resolution.kind === 'none') {
    // "Nothing was made" is only believable once the call cannot still be running: an unknown
    // result, or an in-flight one older than the carrier timeout (judged by Postgres time).
    const [stale] = await tx
      .select({ id: shipmentOperations.id })
      .from(shipmentOperations)
      .where(
        and(
          eq(shipmentOperations.id, open.id),
          or(
            eq(shipmentOperations.state, 'unknown'),
            sql`${shipmentOperations.createdAt} < now() - interval '2 minutes'`,
          ),
        ),
      );
    if (stale === undefined) throw new WaybillInProgressError();
    await tx
      .update(shipmentOperations)
      .set({ state: 'failed', lastError: 'confirmed with the carrier: no document was made' })
      .where(eq(shipmentOperations.id, open.id));
    return { changed: true, ttn: null };
  }
  const { ttn } = input.resolution;
  const [target] = await tx
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (target?.status === 'cancelled') throw new WaybillNotAllowedError('the order is cancelled');
  if (!isWaybillNumber(ttn)) throw new WaybillNotAllowedError('a waybill number has 14 digits');
  const [taken] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.ttn, ttn));
  if (taken !== undefined)
    throw new WaybillNotAllowedError('this number belongs to an order already');
  await tx
    .update(shipmentOperations)
    .set({ state: 'succeeded', ttn, lastError: null })
    .where(eq(shipmentOperations.id, open.id));
  await recordWaybill(tx, {
    orderId: input.orderId,
    ttn,
    cost: null,
    actorUserId: input.actorUserId,
    comment: 'entered by hand after checking the carrier',
    notify: true,
  });
  return { changed: true, ttn };
}

/** The waybill number stored on an order (what the print route reads: never a number from a request). */
export async function orderWaybillNumber(reader: Reader, orderId: string): Promise<string | null> {
  const [row] = await reader.select({ ttn: orders.ttn }).from(orders).where(eq(orders.id, orderId));
  return row?.ttn ?? null;
}
