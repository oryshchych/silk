/**
 * Refunds through `refund_operations` (ADR-4 source 4, docs on
 * refund_operations in schema.ts).
 *
 * Rule: under the payment lock check the budget, RESERVE the amount by
 * committing the operation, and only then call the provider. A timeout is
 * `unknown`, which keeps the budget held until reconciliation: a refund the
 * provider may already have executed must never be repeated.
 *
 *   BUDGET = captured_amount of the attempt
 *            - SUM(amount) of its refund operations in
 *              pending, in_flight, unknown and succeeded
 *
 * Steps (each its own short transaction, no lock held across the provider call):
 *   requestRefund -> claimRefund (pending -> in_flight, once) -> provider.refund
 *   -> settleRefund (the result)
 *
 * A refund goes to the provider of the attempt that took the money, never "to the
 * card" in general (docs/GIFT_CARDS.md section 0).
 *
 * Lock order (ADR-22): orders (3), then payment_attempts (5). Refund operations have
 * no lock level of their own: the order lock serialises everything that touches them.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  auditLog,
  orderStatusHistory,
  orders,
  outbox,
  paymentAttempts,
  refundOperations,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';
import type { PaymentProvider, RefundResult } from '@store/payments/types';
import { add, money, subtract, type Money } from '@store/shared/money';

import { RefundBudgetError, RefundNotAllowedError, RefundRoutingError } from '../errors.ts';
import { enqueueReturnReceipt } from '../fiscal/receipts.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';

/** States that hold budget: an `unknown` or in-flight refund may already have moved money. */
const HOLDS_BUDGET = ['pending', 'in_flight', 'unknown', 'succeeded'] as const;

export type ProviderCode = 'mono' | 'wayforpay';
export type ProviderMap = Partial<Record<ProviderCode, PaymentProvider>>;

/** One source of truth for routing: the providers that are actually registered. */
export const routesOf = (providers: ProviderMap): string[] => Object.keys(providers);

const MAX_REASON_LENGTH = 200;

export interface RefundRequest {
  orderId: string;
  attemptId: string;
  /** Positive whole kopiykas. */
  amount: Money;
  reason: string | null;
  /** Who asked (admin user id); null for the system. */
  initiatedBy: string | null;
  /**
   * The registered providers, the same map `processRefund` uses: routing is checked BEFORE any
   * amount is reserved, and there is no second list that could drift from the first.
   */
  providers: ProviderMap;
  /** The caller writes the audit row itself (an admin action: author and address, one row). */
  auditByCaller?: boolean;
}

export interface RefundReservation {
  operationId: string;
  localReference: string;
  attemptId: string;
  amount: Money;
}

/** Budget left on an attempt. The held sum is read as bigint and converted through `money`. */
async function remainingBudget(tx: Tx, attemptId: string, captured: number): Promise<Money> {
  const [held] = await tx
    .select({ sum: sql<string>`coalesce(sum(${refundOperations.amount}), 0)::bigint` })
    .from(refundOperations)
    .where(
      and(
        eq(refundOperations.paymentAttemptId, attemptId),
        inArray(refundOperations.state, [...HOLDS_BUDGET]),
      ),
    );
  return subtract(money(captured), money(Number(held?.sum ?? 0)));
}

type Attempt = typeof paymentAttempts.$inferSelect;

/** Validates and reserves under locks the caller already holds (orders, then the attempt). */
async function reserveUnderLocks(
  tx: Tx,
  input: RefundRequest,
  attempt: Attempt,
): Promise<RefundReservation> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new RefundBudgetError('the amount must be positive whole kopiykas');
  }
  if (input.reason !== null && input.reason.length > MAX_REASON_LENGTH) {
    // Free text can carry customer data: keep it short, use a code where possible.
    throw new RefundNotAllowedError('the reason is too long');
  }
  if (!routesOf(input.providers).includes(attempt.provider)) {
    throw new RefundRoutingError(attempt.provider);
  }
  if (attempt.capturedAmount <= 0) throw new RefundNotAllowedError('nothing was captured');
  if (attempt.externalId === null) {
    throw new RefundNotAllowedError('the attempt has no provider invoice to refund');
  }

  const budget = await remainingBudget(tx, attempt.id, attempt.capturedAmount);
  if (input.amount > budget) {
    throw new RefundBudgetError(`${String(input.amount)} requested, ${String(budget)} left`);
  }

  const [operation] = await tx
    .insert(refundOperations)
    .values({
      orderId: input.orderId,
      paymentAttemptId: attempt.id,
      amount: input.amount,
      reason: input.reason,
      initiatedByUserId: input.initiatedBy,
    })
    .returning({ id: refundOperations.id, localReference: refundOperations.localReference });
  if (operation === undefined) throw new Error('refund operation insert returned no row');
  if (input.auditByCaller !== true) {
    await tx.insert(auditLog).values({
      userId: input.initiatedBy,
      action: 'refund',
      entity: 'order',
      entityId: input.orderId,
      diff: { operationId: operation.id, amount: input.amount, state: 'pending' },
    });
  }
  return {
    operationId: operation.id,
    localReference: operation.localReference,
    attemptId: attempt.id,
    amount: input.amount,
  };
}

/** Reserves `amount` of the attempt's captured money. Call inside a transaction, commit, THEN call the provider. */
export async function requestRefund(tx: Tx, input: RefundRequest): Promise<RefundReservation> {
  await acquireLocks(tx, { orders: [input.orderId], payment_attempts: [input.attemptId] });
  const [attempt] = await tx
    .select()
    .from(paymentAttempts)
    .where(
      and(eq(paymentAttempts.id, input.attemptId), eq(paymentAttempts.orderId, input.orderId)),
    );
  if (attempt === undefined)
    throw new RefundNotAllowedError('no such payment attempt on this order');
  return await reserveUnderLocks(tx, input, attempt);
}

/** Full refund: one operation per paid attempt, each for what is left of its capture. */
export async function requestFullRefund(
  tx: Tx,
  input: Omit<RefundRequest, 'attemptId' | 'amount'>,
): Promise<RefundReservation[]> {
  // Every lock up front, in ADR-22 order: the helper refuses a later request for a lower level.
  // The candidate list is read after the ORDER lock (nothing can add a captured attempt now) and
  // BEFORE the attempt locks, because those need the ids; the budget is recomputed under them.
  await acquireLocks(tx, { orders: [input.orderId] });
  const candidates = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(eq(paymentAttempts.orderId, input.orderId), sql`${paymentAttempts.capturedAmount} > 0`),
    )
    .orderBy(asc(paymentAttempts.id));
  await acquireLocks(tx, { payment_attempts: candidates.map((c) => c.id) });
  const attempts = await tx
    .select()
    .from(paymentAttempts)
    .where(
      inArray(
        paymentAttempts.id,
        candidates.map((c) => c.id),
      ),
    )
    .orderBy(asc(paymentAttempts.id));

  const reservations: RefundReservation[] = [];
  for (const attempt of attempts) {
    const budget = await remainingBudget(tx, attempt.id, attempt.capturedAmount);
    if (budget > 0) {
      reservations.push(
        await reserveUnderLocks(tx, { ...input, attemptId: attempt.id, amount: budget }, attempt),
      );
    }
  }
  if (reservations.length === 0) throw new RefundBudgetError('nothing is left to refund');
  return reservations;
}

export interface Claim {
  claimed: boolean;
  state: string;
  provider: string;
  externalId: string;
  localReference: string;
  amount: Money;
}

/** pending -> in_flight exactly once, so a double click cannot call the provider twice. */
export async function claimRefund(
  tx: Tx,
  operationId: string,
  routes: readonly string[],
): Promise<Claim> {
  const [probe] = await tx
    .select({ orderId: refundOperations.orderId, attemptId: refundOperations.paymentAttemptId })
    .from(refundOperations)
    .where(eq(refundOperations.id, operationId));
  if (probe === undefined || probe.attemptId === null) {
    throw new RefundNotAllowedError('no such refund operation');
  }
  await acquireLocks(tx, { orders: [probe.orderId], payment_attempts: [probe.attemptId] });

  // Routing BEFORE the claim: an operation nobody can send must not be left in flight.
  const [route] = await tx
    .select({ provider: paymentAttempts.provider })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, probe.attemptId));
  if (route === undefined || !routes.includes(route.provider)) {
    throw new RefundRoutingError(route?.provider ?? 'unknown');
  }

  const claimed = await tx.execute<{ id: string }>(
    sql`UPDATE refund_operations SET state = 'in_flight'
         WHERE id = ${operationId} AND state = 'pending'
        RETURNING id`,
  );
  const [operation] = await tx
    .select()
    .from(refundOperations)
    .where(eq(refundOperations.id, operationId));
  const [attempt] = await tx
    .select({ provider: paymentAttempts.provider, externalId: paymentAttempts.externalId })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, probe.attemptId));
  if (operation === undefined || attempt === undefined || attempt.externalId === null) {
    throw new RefundNotAllowedError('the refund operation lost its payment attempt');
  }
  return {
    claimed: claimed.rows.length > 0,
    state: operation.state,
    provider: attempt.provider,
    externalId: attempt.externalId,
    localReference: operation.localReference,
    amount: money(operation.amount),
  };
}

export interface SettleResult {
  changed: boolean;
  state: string;
}

type Confirmation = { by: string | null };

/**
 * Where an outcome comes from decides what it may do.
 *
 * - `provider-call`: the result of OUR OWN call, made by `processRefund` right after it claimed the
 *   operation (state `in_flight`). It may settle, fail or mark it unknown.
 * - `confirmed`: a reconciliation or a person who checked with the provider, recorded in the audit
 *   log. It is the only way to close an `in_flight` or `unknown` operation as succeeded or failed
 *   from outside the call: a crash can leave a refund that WAS sent in either state, and closing it
 *   as failed without proof would free the budget and allow the double refund this design prevents.
 *
 * A `pending` operation was never claimed, so it can be neither settled nor failed here: it goes
 * through `claimRefund`, or is withdrawn with `cancelPendingRefund`.
 */
type Source = { kind: 'provider-call' } | { kind: 'confirmed'; confirmation: Confirmation };

async function applyOutcome(
  tx: Tx,
  input: { operationId: string; outcome: RefundResult; source: Source },
): Promise<SettleResult> {
  const [probe] = await tx
    .select({ orderId: refundOperations.orderId, attemptId: refundOperations.paymentAttemptId })
    .from(refundOperations)
    .where(eq(refundOperations.id, input.operationId));
  if (probe === undefined || probe.attemptId === null) {
    throw new RefundNotAllowedError('no such refund operation');
  }
  await acquireLocks(tx, { orders: [probe.orderId], payment_attempts: [probe.attemptId] });
  const [operation] = await tx
    .select()
    .from(refundOperations)
    .where(eq(refundOperations.id, input.operationId));
  if (operation === undefined) throw new RefundNotAllowedError('no such refund operation');
  if (!['pending', 'in_flight', 'unknown'].includes(operation.state)) {
    return { changed: false, state: operation.state }; // already settled: idempotent
  }

  const { outcome, source } = input;
  if (operation.state === 'pending') {
    throw new RefundNotAllowedError('a refund that was never claimed cannot be settled');
  }
  const closes = outcome.state === 'succeeded' || outcome.state === 'failed';
  if (!closes) {
    // `unknown` and `in_flight` only describe our own call: they never demote or re-open anything else.
    const fromOurCall = source.kind === 'provider-call' && operation.state === 'in_flight';
    if (!fromOurCall || outcome.state === 'in_flight') {
      return { changed: false, state: operation.state };
    }
  } else if (source.kind !== 'confirmed' && operation.state !== 'in_flight') {
    throw new RefundNotAllowedError('an unknown refund needs a confirmation to be settled');
  }

  const error = 'error' in outcome ? outcome.error.slice(0, 200) : null;
  const providerReference = 'providerReference' in outcome ? outcome.providerReference : null;
  await tx
    .update(refundOperations)
    .set({
      state: outcome.state,
      lastError: error,
      providerReference,
      settledAt: closes ? sql`now()` : null,
    })
    .where(eq(refundOperations.id, operation.id));
  if (source.kind === 'confirmed') {
    await tx.insert(auditLog).values({
      userId: source.confirmation.by,
      action: 'refund',
      entity: 'order',
      entityId: operation.orderId,
      diff: { operationId: operation.id, confirmed: outcome.state, from: operation.state },
    });
  }

  if (outcome.state === 'succeeded') {
    await applySucceeded(tx, operation.orderId, money(operation.amount), operation.id);
  }
  return { changed: true, state: outcome.state };
}

/**
 * Closes an `in_flight` or `unknown` refund with the provider's confirmation (reconciliation) or a
 * person's, audited. Idempotent: a settled operation does not move again. The result of our own
 * provider call does NOT come through here (see `processRefund`).
 */
export async function settleRefund(
  tx: Tx,
  input: {
    operationId: string;
    outcome: RefundResult;
    confirmation: Confirmation;
  },
): Promise<SettleResult> {
  return await applyOutcome(tx, {
    operationId: input.operationId,
    outcome: input.outcome,
    source: { kind: 'confirmed', confirmation: input.confirmation },
  });
}

/**
 * A reservation that was never sent (still `pending`: the provider was never called) can be
 * withdrawn safely; it frees the budget. Anything past `pending` cannot, see settleRefund.
 */
export async function cancelPendingRefund(tx: Tx, operationId: string): Promise<boolean> {
  const [probe] = await tx
    .select({ orderId: refundOperations.orderId, attemptId: refundOperations.paymentAttemptId })
    .from(refundOperations)
    .where(eq(refundOperations.id, operationId));
  if (probe === undefined || probe.attemptId === null) return false;
  await acquireLocks(tx, { orders: [probe.orderId], payment_attempts: [probe.attemptId] });
  const cancelled = await tx.execute(
    sql`UPDATE refund_operations SET state = 'failed', last_error = 'withdrawn before sending',
                                     settled_at = now()
         WHERE id = ${operationId} AND state = 'pending'
        RETURNING id`,
  );
  return cancelled.rows.length > 0;
}

async function applySucceeded(
  tx: Tx,
  orderId: string,
  amount: Money,
  operationId: string,
): Promise<void> {
  const [before] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (before === undefined) throw new Error(`order ${orderId} vanished`);
  const refunded = add(money(before.refundedTotal), amount);
  const next = refunded >= before.capturedTotal ? 'refunded' : 'partially_refunded';
  // orders_refund_lte_captured is the database's last line: it fails the transaction on overshoot.
  await tx
    .update(orders)
    .set({ refundedTotal: refunded, paymentStatus: next })
    .where(eq(orders.id, orderId));
  if (next !== before.paymentStatus) {
    await tx.insert(orderStatusHistory).values({
      orderId,
      fromStatus: before.paymentStatus,
      toStatus: next,
      field: 'payment_status',
      source: 'refund',
      comment: operationId,
    });
  }
  await tx.insert(auditLog).values({
    action: 'refund',
    entity: 'order',
    entityId: orderId,
    diff: { operationId, amount, state: 'succeeded', refundedTotal: refunded },
  });
  // The return receipt points at the primary one; a queue job issues it (ADR-16).
  await enqueueReturnReceipt(tx, { orderId, refundOperationId: operationId, amount });
  // Event, state, history and outbox commit together (AGENTS.md 5b); the buyer's mail leaves
  // through the outbox, once per operation.
  await tx
    .insert(outbox)
    .values({
      topic: 'email.refund-issued',
      payload: { orderId, operationId },
      dedupKey: `refund:${operationId}`,
    })
    .onConflictDoNothing();
}

export interface RefundDeps {
  providers: ProviderMap;
  runInTransaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

/**
 * Executes a reserved refund: claim, call the provider (no transaction open), settle.
 * `called` tells whether THIS call reached the provider (false for a lost claim race or
 * an operation that is already past `pending`, e.g. in flight after a crash: those are
 * reconciled, never re-sent blindly).
 */
export async function processRefund(
  deps: RefundDeps,
  operationId: string,
): Promise<{ called: boolean; state: string }> {
  const routes = routesOf(deps.providers);
  const claim = await deps.runInTransaction(
    async (tx) => await claimRefund(tx, operationId, routes),
  );
  if (!claim.claimed) return { called: false, state: claim.state };

  const provider =
    claim.provider === 'mono'
      ? deps.providers.mono
      : claim.provider === 'wayforpay'
        ? deps.providers.wayforpay
        : undefined;
  if (provider === undefined) throw new RefundRoutingError(claim.provider);

  let outcome: RefundResult;
  try {
    outcome = await provider.refund({
      localReference: claim.localReference,
      externalId: claim.externalId,
      amount: claim.amount,
    });
  } catch {
    outcome = { state: 'unknown', error: 'the provider call threw: result unknown' };
  }
  const settled = await deps.runInTransaction(
    async (tx) =>
      await applyOutcome(tx, { operationId, outcome, source: { kind: 'provider-call' } }),
  );
  return { called: true, state: settled.state };
}
