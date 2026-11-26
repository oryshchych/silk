/**
 * The admin's one-step status workflow and the internal notes (phase 5). Ship and cancel stay in
 * `orders/fulfilment.ts` (the stock-touching operations of ADR-18); this file holds the steps that
 * move no stock: confirm, process, deliver.
 *
 * Every function takes the transaction first (AGENTS.md 4b.1), locks the order (ADR-22, level 3)
 * and is idempotent: a repeat sees the new status and changes nothing, so a double click or a
 * second tab cannot write a second history row.
 */
import { eq, sql } from 'drizzle-orm';

import { orderStatusHistory, orders } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { AdminNotFoundError } from '../catalog-admin/errors.ts';
import { OrderNotConfirmableError, OrderTransitionError } from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { confirmCodOrder } from '../payments/offline.ts';

export interface AdvanceResult {
  orderId: string;
  /** False when an earlier call already moved the order: nothing was written. */
  changed: boolean;
  from: string;
  to: string;
}

export const ADMIN_SOURCE = 'admin';

type Step = 'confirmed' | 'processing' | 'delivered';

async function lockedOrder(tx: Tx, orderId: string) {
  await acquireLocks(tx, { orders: [orderId] });
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (order === undefined) throw new AdminNotFoundError('order');
  return order;
}

/**
 * Confirm (pending to confirmed), process (confirmed to processing) or mark delivered (shipped to
 * delivered). A card or transfer order is confirmed only once its payment is `paid` (a confirmed
 * server source, ADR-4); a COD order is confirmed by the manager, which also lifts the reservation
 * expiry (`confirmCodOrder`, owner queue Q16).
 */
export async function advanceOrder(
  tx: Tx,
  input: { orderId: string; to: Step; actorUserId: string },
): Promise<AdvanceResult> {
  const order = await lockedOrder(tx, input.orderId);
  const actor = { actorUserId: input.actorUserId, auditByCaller: true };
  // The author is the history row's own column; `source` (40 characters) names the channel only.
  const source = ADMIN_SOURCE;

  if (input.to === 'confirmed') {
    if (order.status === 'confirmed' || order.status === 'processing') {
      return { orderId: order.id, changed: false, from: order.status, to: 'confirmed' };
    }
    if (order.status !== 'pending') throw new OrderTransitionError(`the order is ${order.status}`);
    if (order.paymentProvider === 'cod') {
      const done = await confirmCodOrder(tx, {
        orderId: order.id,
        actor: 'admin',
        ...actor,
      });
      return { orderId: order.id, changed: done.changed, from: 'pending', to: 'confirmed' };
    }
    if (order.paymentStatus !== 'paid') {
      throw new OrderNotConfirmableError('the payment is not confirmed yet');
    }
    await tx.update(orders).set({ status: 'confirmed' }).where(eq(orders.id, order.id));
    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      fromStatus: 'pending',
      toStatus: 'confirmed',
      field: 'status',
      changedByUserId: input.actorUserId,
      source,
      comment: null,
    });
    return { orderId: order.id, changed: true, from: 'pending', to: 'confirmed' };
  }

  if (input.to === 'processing') {
    if (order.status === 'processing') {
      return { orderId: order.id, changed: false, from: order.status, to: 'processing' };
    }
    if (order.status !== 'confirmed')
      throw new OrderTransitionError(`the order is ${order.status}`);
    await tx.update(orders).set({ status: 'processing' }).where(eq(orders.id, order.id));
    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      fromStatus: 'confirmed',
      toStatus: 'processing',
      field: 'status',
      changedByUserId: input.actorUserId,
      source,
      comment: null,
    });
    return { orderId: order.id, changed: true, from: 'confirmed', to: 'processing' };
  }

  if (order.status === 'delivered') {
    return { orderId: order.id, changed: false, from: order.status, to: 'delivered' };
  }
  if (order.status !== 'shipped') throw new OrderTransitionError(`the order is ${order.status}`);
  await tx
    .update(orders)
    .set({ status: 'delivered', deliveredAt: sql`now()` })
    .where(eq(orders.id, order.id));
  await tx.insert(orderStatusHistory).values({
    orderId: order.id,
    fromStatus: 'shipped',
    toStatus: 'delivered',
    field: 'status',
    changedByUserId: input.actorUserId,
    source,
    comment: null,
  });
  return { orderId: order.id, changed: true, from: 'shipped', to: 'delivered' };
}

/** An internal note: an append-only history row with the author, never shown to the buyer. */
export async function addOrderNote(
  tx: Tx,
  input: { orderId: string; text: string; actorUserId: string },
): Promise<{ orderId: string }> {
  await lockedOrder(tx, input.orderId);
  await tx.insert(orderStatusHistory).values({
    orderId: input.orderId,
    fromStatus: null,
    toStatus: 'note',
    field: 'note',
    changedByUserId: input.actorUserId,
    source: ADMIN_SOURCE,
    comment: input.text,
  });
  return { orderId: input.orderId };
}
