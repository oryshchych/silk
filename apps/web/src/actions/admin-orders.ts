'use server';

import { cancelOrder, shipOrder } from '@store/core/fulfilment';
import { advanceOrder, addOrderNote, ADMIN_SOURCE } from '@store/core/orders-admin';
import {
  cancelOrderSchema,
  confirmTransferSchema,
  orderIdSchema,
  orderNoteSchema,
} from '@store/core/orders-admin-schemas';
import { confirmTransferReceived } from '@store/core/offline';

import { adminAction } from '@/lib/admin/bound-action';

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
      });
      if (!done.changed) {
        skipAudit();
        return { changed: false };
      }
      await audit(transitionAudit(parsed.orderId, 'status', 'open', 'shipped'));
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
        return { changed: false };
      }
      await audit(
        transitionAudit(parsed.orderId, 'status', 'open', 'cancelled', { reason: parsed.reason }),
      );
      return { changed: true };
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
      await audit(transitionAudit(parsed.orderId, 'payment_status', 'pending', 'paid'));
      return { changed: true };
    },
  });
}
