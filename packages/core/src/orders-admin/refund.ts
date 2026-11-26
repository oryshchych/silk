/**
 * The admin side of a refund (phase 5): the reservation of the amount, under the order lock, with
 * the author. The provider call is NOT made here: the caller commits this transaction first and
 * then runs `processRefund` (no transaction is open while the provider is called, ADR-4). The
 * state `payment_status` moves to `refunded` or `partially_refunded` only when `processRefund`
 * settles the operation with the provider's answer; the browser never decides it.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { orders, paymentAttempts } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { money, type Money } from '@store/shared/money';

import { AdminNotFoundError } from '../catalog-admin/errors.ts';
import { RefundNotAllowedError } from '../errors.ts';
import {
  requestFullRefund,
  requestRefund,
  type ProviderMap,
  type RefundReservation,
} from '../payments/refunds.ts';

export async function reserveAdminRefund(
  tx: Tx,
  input: {
    orderId: string;
    /** Whole kopiykas; undefined refunds everything that is left. */
    amount?: Money | undefined;
    attemptId?: string | undefined;
    reason: string;
    actorUserId: string;
    providers: ProviderMap;
  },
): Promise<RefundReservation[]> {
  const [order] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (order === undefined) throw new AdminNotFoundError('order');
  const base = {
    orderId: input.orderId,
    reason: input.reason,
    initiatedBy: input.actorUserId,
    providers: input.providers,
    auditByCaller: true,
  };
  if (input.amount === undefined) return await requestFullRefund(tx, base);

  let attemptId = input.attemptId;
  if (attemptId === undefined) {
    const captured = await tx
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.orderId, input.orderId), sql`${paymentAttempts.capturedAmount} > 0`),
      )
      .orderBy(asc(paymentAttempts.id));
    if (captured.length !== 1 || captured[0] === undefined) {
      throw new RefundNotAllowedError('choose the payment to refund');
    }
    attemptId = captured[0].id;
  }
  return [await requestRefund(tx, { ...base, attemptId, amount: money(input.amount) })];
}
