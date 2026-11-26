'use server';

import { writeAudit } from '@store/core/audit';
import { RefundNotAllowedError } from '@store/core/errors';
import type { WaybillCarrier } from '@store/payments/shipping';
import { cancelOrder, shipOrder } from '@store/core/fulfilment';
import { advanceOrder, addOrderNote, ADMIN_SOURCE } from '@store/core/orders-admin';
import { editOrderItems } from '@store/core/orders-admin-edit';
import { reserveAdminRefund } from '@store/core/orders-admin-refund';
import { refundOperationOrder } from '@store/core/refund-sweep';
import {
  cancelPendingRefund,
  processRefund,
  settleRefund,
  type ProviderMap,
} from '@store/core/refunds';
import { WaybillNotConfiguredError } from '@store/core/errors';
import { beginWaybill, completeWaybill, resolveWaybill } from '@store/core/waybill';
import {
  cancelOrderSchema,
  confirmTransferSchema,
  editItemsSchema,
  refundOperationSchema,
  refundSchema,
  resolveRefundSchema,
  resolveWaybillSchema,
  orderIdSchema,
  orderNoteSchema,
} from '@store/core/orders-admin-schemas';
import { confirmTransferReceived } from '@store/core/offline';

import { adminAction } from '@/lib/admin/bound-action';
import { getDb } from '@/lib/db';
import { getPaymentProviders } from '@/lib/payment-providers';
import { getWaybillCarrier } from '@/lib/waybill-carrier';

/**
 * Order mutations. Each one names ONE permission (`adminAction` checks it before the input is
 * parsed), runs the domain function in the action's transaction with the author from the verified
 * session, and writes ONE audit row with the author and address. A repeat that changed nothing
 * (a double click, a second tab) writes no second history or audit row.
 */
type Field = 'status' | 'payment_status';

const transitionAudit = (orderId: string, field: Field, from: string, to: string, extra = {}) =>
  ({
    action: 'transition',
    entity: 'order',
    entityId: orderId,
    diff: { field, from, to, ...extra },
  }) as const;

async function step(input: unknown, to: 'confirmed' | 'processing' | 'delivered') {
  return await adminAction({
    permission: 'orders.manage',
    schema: orderIdSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await advanceOrder(tx, {
        orderId: parsed.orderId,
        to,
        actorUserId: session.userId,
      });
      if (!done.changed) {
        skipAudit();
        return { changed: false };
      }
      await audit(transitionAudit(parsed.orderId, 'status', done.from, done.to));
      return { changed: true };
    },
  });
}

export async function confirmOrderAction(input: unknown) {
  return await step(input, 'confirmed');
}

export async function processOrderAction(input: unknown) {
  return await step(input, 'processing');
}

export async function deliverOrderAction(input: unknown) {
  return await step(input, 'delivered');
}

/** Ship: the one step that takes goods off the shelf (ADR-18); refused unless the payment allows it. */
export async function shipOrderAction(input: unknown) {
  return await adminAction({
    permission: 'orders.manage',
    schema: orderIdSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await shipOrder(tx, {
        orderId: parsed.orderId,
        source: ADMIN_SOURCE,
        actorUserId: session.userId,
        auditByCaller: true,
        requireConfirmed: true,
      });
      if (!done.changed) {
        skipAudit();
        return { changed: false };
      }
      await audit(transitionAudit(parsed.orderId, 'status', done.from, 'shipped'));
      return { changed: true };
    },
  });
}

/** Cancel: releases the reservation, never touches `stock_quantity`; the comment is mandatory. */
export async function cancelOrderAction(input: unknown) {
  return await adminAction({
    permission: 'orders.cancel',
    schema: cancelOrderSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await cancelOrder(tx, {
        orderId: parsed.orderId,
        source: ADMIN_SOURCE,
        reason: parsed.reason,
        actorUserId: session.userId,
        auditByCaller: true,
      });
      if (!done.changed) {
        skipAudit();
        return { changed: false, refundDue: 0, heldAuthorization: false };
      }
      await audit(
        transitionAudit(parsed.orderId, 'status', done.from, 'cancelled', {
          reason: parsed.reason,
        }),
      );
      // Money that was received is not given back by a cancellation: tell the person, who starts the
      // refund from the card (the same figure goes to the owner through the outbox).
      return {
        changed: true,
        refundDue: Math.max(0, done.refundable ?? 0),
        heldAuthorization: done.heldAuthorization === true,
      };
    },
  });
}

export async function addOrderNoteAction(input: unknown) {
  return await adminAction({
    permission: 'orders.manage',
    schema: orderNoteSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      await addOrderNote(tx, {
        orderId: parsed.orderId,
        text: parsed.text,
        actorUserId: session.userId,
      });
      // The text is not copied into the audit row: it lives in the history, with its author.
      await audit({ action: 'create', entity: 'order_note', entityId: parsed.orderId, diff: {} });
      return { changed: true };
    },
  });
}

/** A bank transfer the manager saw on the statement: the confirmed source of the payment (ADR-4). */
export async function confirmTransferAction(input: unknown) {
  return await adminAction({
    permission: 'orders.confirm_payment',
    schema: confirmTransferSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await confirmTransferReceived(tx, {
        orderId: parsed.orderId,
        actor: 'admin',
        bankReference: parsed.bankReference,
        receivedAmount: parsed.amount,
        actorUserId: session.userId,
        auditByCaller: true,
      });
      if (!done.changed) {
        skipAudit();
        return { changed: false };
      }
      await audit(
        transitionAudit(parsed.orderId, 'payment_status', done.paymentFrom ?? 'pending', 'paid', {
          ...(done.statusChange === undefined ? {} : { status: done.statusChange }),
        }),
      );
      return { changed: true };
    },
  });
}

/** Change quantities or remove lines of an order that has not shipped; the reason is mandatory. */
export async function editOrderItemsAction(input: unknown) {
  return await adminAction({
    permission: 'orders.edit',
    schema: editItemsSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await editOrderItems(tx, {
        orderId: parsed.orderId,
        changes: parsed.changes,
        reason: parsed.reason,
        actorUserId: session.userId,
      });
      if (!done.changed) {
        skipAudit();
        return { changed: false, refundDue: 0 };
      }
      await audit({
        action: 'update',
        entity: 'order_items',
        entityId: parsed.orderId,
        diff: {
          changes: done.applied,
          total: { from: done.totalFrom, to: done.totalTo },
          reason: parsed.reason,
        },
      });
      return { changed: true, refundDue: done.refundDue };
    },
  });
}

/**
 * Refund in two steps that never share a transaction (ADR-4): the amount is reserved and audited
 * in the action's transaction, and only after it COMMITTED is the provider called. The status of
 * the order moves when the provider's answer settles the operation, never before.
 */
export async function refundOrderAction(input: unknown) {
  // Built after the permission check (inside `run`), used again after the commit.
  let providers: ProviderMap = {};
  const reserved = await adminAction({
    permission: 'orders.refund',
    schema: refundSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      providers = await getPaymentProviders();
      const reservations = await reserveAdminRefund(tx, {
        orderId: parsed.orderId,
        amount: parsed.amount,
        attemptId: parsed.attemptId,
        requestId: parsed.requestId,
        reason: parsed.reason,
        actorUserId: session.userId,
        providers,
      });
      await audit({
        action: 'refund',
        entity: 'order',
        entityId: parsed.orderId,
        diff: {
          operations: reservations.map((r) => ({ operationId: r.operationId, amount: r.amount })),
        },
      });
      return reservations.map((r) => r.operationId);
    },
  });
  if (!reserved.ok) return reserved;
  const db = await getDb();
  // Each operation on its own: one that cannot be sent (routing, a settle error) must not skip the
  // others or turn a committed reservation into a 500. Its state is reported as it is.
  const states: string[] = [];
  for (const operationId of reserved.data) {
    try {
      const outcome = await processRefund(
        { providers, runInTransaction: async (fn) => await db.transaction(fn) },
        operationId,
      );
      states.push(outcome.state);
    } catch {
      states.push('pending');
    }
  }
  return { ok: true as const, data: { states } };
}

/**
 * A Nova Poshta waybill in three steps (see `core/shipping/waybill.ts`): the operation is recorded
 * and COMMITTED, the carrier is called with no transaction open, and the answer settles the
 * operation in a second transaction. A lost answer leaves the operation live: nothing here ever
 * calls `save` a second time for the order.
 */
export async function createWaybillAction(input: unknown) {
  // Built after the permission check (inside `run`), used again after the commit.
  const holder: { carrier: WaybillCarrier | null } = { carrier: null };
  const begun = await adminAction({
    permission: 'orders.waybill',
    schema: orderIdSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      holder.carrier = await getWaybillCarrier();
      const carrier = holder.carrier;
      if (carrier === null) throw new WaybillNotConfiguredError();
      const started = await beginWaybill(tx, { orderId: parsed.orderId });
      await audit({
        action: 'create',
        entity: 'shipment_operation',
        entityId: parsed.orderId,
        diff: { operationId: started.operationId, carrier: carrier.code },
      });
      return { ...started, userId: session.userId, orderId: parsed.orderId };
    },
  });
  const sender = holder.carrier;
  if (!begun.ok || sender === null) return begun;
  const result = await sender.createWaybill(begun.data.request);
  const db = await getDb();
  const settled = await db.transaction(async (tx) => {
    const done = await completeWaybill(tx, {
      operationId: begun.data.operationId,
      result,
      actorUserId: begun.data.userId,
    });
    if (done.changed) {
      // The answer settled the operation: its own audit row (the request row was written at the start).
      await writeAudit(tx, {
        userId: begun.data.userId,
        action: 'update',
        entity: 'shipment_operation',
        entityId: begun.data.orderId,
        diff: { state: done.state, ttn: done.ttn },
      });
    }
    return done;
  });
  return { ok: true as const, data: { state: settled.state, ttn: settled.ttn } };
}

/** A person closes an unknown waybill after checking the carrier's portal. */
export async function resolveWaybillAction(input: unknown) {
  return await adminAction({
    permission: 'orders.waybill',
    schema: resolveWaybillSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await resolveWaybill(tx, {
        orderId: parsed.orderId,
        resolution: parsed.resolution,
        actorUserId: session.userId,
      });
      if (!done.changed) {
        skipAudit();
        return { changed: false, ttn: null };
      }
      await audit({
        action: 'update',
        entity: 'shipment_operation',
        entityId: parsed.orderId,
        diff: { resolution: parsed.resolution.kind, ttn: done.ttn },
      });
      return { changed: true, ttn: done.ttn };
    },
  });
}

/** Withdraw a refund that was reserved but never sent: it frees the budget. Only a `pending` one can be. */
export async function withdrawRefundAction(input: unknown) {
  return await adminAction({
    permission: 'orders.refund',
    schema: refundOperationSchema,
    input,
    run: async ({ tx, input: parsed, audit, skipAudit }) => {
      const orderId = await refundOperationOrder(tx, parsed.operationId);
      if (orderId === null) throw new RefundNotAllowedError('no such refund operation');
      const withdrawn = await cancelPendingRefund(tx, parsed.operationId);
      if (!withdrawn) {
        skipAudit();
        return { changed: false };
      }
      await audit({
        action: 'refund',
        entity: 'order',
        entityId: orderId,
        diff: { operationId: parsed.operationId, withdrawn: true },
      });
      return { changed: true };
    },
  });
}

/**
 * Close a refund whose answer is unknown (`in_flight` or `unknown`) with what the provider's portal
 * says. This is a person's confirmation, recorded with the author (`settleRefund`); nothing is
 * guessed, and a refund the provider already settled does not move again.
 */
export async function resolveRefundAction(input: unknown) {
  return await adminAction({
    permission: 'orders.refund',
    schema: resolveRefundSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const orderId = await refundOperationOrder(tx, parsed.operationId);
      if (orderId === null) throw new RefundNotAllowedError('no such refund operation');
      const done = await settleRefund(tx, {
        operationId: parsed.operationId,
        outcome:
          parsed.outcome === 'succeeded'
            ? { state: 'succeeded', providerReference: null }
            : { state: 'failed', error: `confirmed by a person: ${parsed.note}` },
        confirmation: { by: session.userId },
      });
      if (!done.changed) {
        skipAudit();
        return { changed: false, state: done.state };
      }
      await audit({
        action: 'refund',
        entity: 'order',
        entityId: orderId,
        diff: { operationId: parsed.operationId, confirmed: parsed.outcome, note: parsed.note },
      });
      return { changed: true, state: done.state };
    },
  });
}
