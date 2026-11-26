'use server';

import {
  approveReturn,
  approveSchema,
  closeReturn,
  idSchema,
  receiveReturn,
  receiveSchema,
  rejectReturn,
  rejectSchema,
  reserveReturnRefund,
  syncReturnRefund,
} from '@store/core/returns-admin';
import { processRefund, type ProviderMap } from '@store/core/refunds';

import { adminAction } from '@/lib/admin/bound-action';
import { getDb } from '@/lib/db';
import { getPaymentProviders } from '@/lib/payment-providers';

/**
 * Return processing. Every action is `adminAction` (Origin, session, the ONE permission, limit, parse,
 * audit in the same transaction). The review of a request and the PHYSICAL receipt need
 * `returns.manage`; the refund needs `orders.refund` (it moves money). The audit rows name the
 * decision and the quantities, never the customer's text.
 */
export async function approveReturnAction(input: unknown) {
  return await adminAction({
    permission: 'returns.manage',
    schema: approveSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      const done = await approveReturn(tx, { userId: session.userId }, parsed);
      await audit({
        action: 'return.approved',
        entity: 'return_request',
        entityId: parsed.id,
        diff: { restock: parsed.restock, refundAmount: done.refundAmount },
      });
      return { ok: true };
    },
  });
}

export async function rejectReturnAction(input: unknown) {
  return await adminAction({
    permission: 'returns.manage',
    schema: rejectSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      const done = await rejectReturn(tx, { userId: session.userId }, parsed);
      await audit({
        action: 'return.rejected',
        entity: 'return_request',
        entityId: parsed.id,
        diff: { from: done.from },
      });
      return { ok: true };
    },
  });
}

/** The parcel is at the warehouse: the ONLY step that puts units back on the shelf (ADR-18). */
export async function receiveReturnAction(input: unknown) {
  return await adminAction({
    permission: 'returns.manage',
    schema: receiveSchema,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await receiveReturn(tx, { userId: session.userId }, parsed);
      if (!done.changed) {
        skipAudit();
        return { changed: false };
      }
      await audit({
        action: 'return.received',
        entity: 'return_request',
        entityId: parsed.id,
        diff: { received: done.received, restocked: done.restocked },
      });
      return { changed: true };
    },
  });
}

export async function closeReturnAction(input: unknown) {
  return await adminAction({
    permission: 'returns.manage',
    schema: idSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      await closeReturn(tx, { userId: session.userId }, parsed.id);
      await audit({ action: 'return.closed', entity: 'return_request', entityId: parsed.id });
      return { ok: true };
    },
  });
}

/**
 * The refund of a received return: reserved in the action's transaction through the phase 5 flow (at most one
 * per return, bounded by the order's budget), COMMITTED, and only then sent to the provider. The return becomes
 * "refunded" only when the provider's answer settled the operation.
 */
export async function refundReturnAction(input: unknown) {
  let providers: ProviderMap = {};
  const reserved = await adminAction({
    permission: 'orders.refund',
    schema: idSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      providers = await getPaymentProviders();
      const done = await reserveReturnRefund(
        tx,
        { userId: session.userId },
        { id: parsed.id, providers },
      );
      await audit({
        action: 'return.refund_reserved',
        entity: 'return_request',
        entityId: parsed.id,
        diff: { operations: done.operationIds },
      });
      return { id: parsed.id, operationIds: done.operationIds };
    },
  });
  if (!reserved.ok) return reserved;
  const db = await getDb();
  const states: string[] = [];
  for (const operationId of reserved.data.operationIds) {
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
  try {
    await db.transaction(async (tx) => await syncReturnRefund(tx, reserved.data.id));
  } catch {
    // The refund is committed; the status catches up the next time the return is opened.
  }
  return { ok: true as const, data: { states } };
}
