/**
 * The sweep of refund operations that nobody is working on (owner queue Q17, phase 5):
 *
 *  - `pending` for more than a few minutes: the reservation was committed but the provider was
 *    never called (the process died between the commit and the call). It was never sent, so it is
 *    safe to send now: `processRefund` claims it `pending -> in_flight` exactly once, so two
 *    sweeps (or a sweep and a person) call the provider once.
 *  - `in_flight` or `unknown` for more than an hour: the answer is not known and the provider
 *    adapters have no refund lookup yet, so the sweep NEVER guesses. It raises an alert once per
 *    operation (outbox, dedup key per operation) and a person closes it from the order card with
 *    what the provider's portal says (`settleRefund` with a confirmation).
 *
 * Ages are judged by Postgres (`now()`), never by the worker's clock.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { outbox, refundOperations } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { processRefund, type RefundDeps } from './refunds.ts';

export const PENDING_AFTER_MINUTES = 5;
export const UNRESOLVED_AFTER_MINUTES = 60;
const BATCH = 50;

export interface SweepResult {
  /** `pending` operations this run sent to the provider. */
  sent: number;
  /** Operations that could not be sent now (routing, a settle error): they stay for the next run. */
  failed: number;
  /** Alerts raised for the first time this run. */
  alerted: number;
}

type Db = RefundDeps['runInTransaction'];

export async function sweepRefunds(
  deps: RefundDeps & { runInTransaction: Db },
  options: { pendingAfterMinutes?: number; unresolvedAfterMinutes?: number } = {},
): Promise<SweepResult> {
  const pendingAfter = options.pendingAfterMinutes ?? PENDING_AFTER_MINUTES;
  const unresolvedAfter = options.unresolvedAfterMinutes ?? UNRESOLVED_AFTER_MINUTES;
  const { stale, unresolved } = await deps.runInTransaction(async (tx: Tx) => ({
    stale: await tx
      .select({ id: refundOperations.id })
      .from(refundOperations)
      .where(
        and(
          eq(refundOperations.state, 'pending'),
          sql`${refundOperations.createdAt} < now() - make_interval(mins => ${pendingAfter})`,
        ),
      )
      .orderBy(asc(refundOperations.createdAt))
      .limit(BATCH),
    unresolved: await tx
      .select({ id: refundOperations.id, orderId: refundOperations.orderId })
      .from(refundOperations)
      .where(
        and(
          inArray(refundOperations.state, ['in_flight', 'unknown']),
          sql`${refundOperations.createdAt} < now() - make_interval(mins => ${unresolvedAfter})`,
        ),
      )
      .orderBy(asc(refundOperations.createdAt))
      .limit(BATCH),
  }));

  let sent = 0;
  let failed = 0;
  for (const operation of stale) {
    try {
      const outcome = await processRefund(deps, operation.id);
      if (outcome.called) sent += 1;
    } catch {
      failed += 1;
    }
  }

  let alerted = 0;
  for (const operation of unresolved) {
    const inserted = await deps.runInTransaction(
      async (tx: Tx) =>
        await tx
          .insert(outbox)
          .values({
            topic: 'alert.refund-unresolved',
            payload: { orderId: operation.orderId, operationId: operation.id },
            dedupKey: `refund-unresolved:${operation.id}`,
          })
          .onConflictDoNothing()
          .returning({ id: outbox.id }),
    );
    alerted += inserted.length;
  }
  return { sent, failed, alerted };
}

/** The order of a refund operation (for the audit row of an admin action), or null. */
export async function refundOperationOrder(tx: Tx, operationId: string): Promise<string | null> {
  const [row] = await tx
    .select({ orderId: refundOperations.orderId })
    .from(refundOperations)
    .where(eq(refundOperations.id, operationId));
  return row?.orderId ?? null;
}
