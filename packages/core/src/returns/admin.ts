/**
 * Processing a return in the admin. The stock and the money move in two DIFFERENT, explicit steps
 * (ADR-18: "receive return" is not "release a reservation" and not "ship stock"):
 *
 *  - RECEIVE (`receiveReturn`): the parcel is physically at the warehouse. Per line, a conditional UPDATE
 *    moves `received_quantity` from the value the transaction read to the new one (so a repeat or a
 *    parallel call applies the difference once), and, when the request restocks, ONE atomic
 *    `stock_quantity = stock_quantity + delta` plus a `stock_adjustments` row (reason `return`) in the
 *    same transaction. Locks: the order (3), its lines (4) in ascending id order, the variants (8), via
 *    `acquireLocks`. Nothing is restocked before this step and a refused or merely approved request never
 *    touches stock.
 *  - REFUND (`reserveReturnRefund`): the money goes through the phase 5 refund flow (`reserveAdminRefund`),
 *    reserved in this transaction and sent by the caller after the commit. One return has at most one
 *    refund operation (a partial unique index and a claim under a per-return lock), and the refund
 *    budget of the order still bounds the amount, so a return and a hand-made refund cannot both
 *    refund the same money.
 *
 * Every transition is a conditional UPDATE on the expected status: two moderators or a double click cannot
 * apply one twice.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader, Tx } from '@store/db/types';
import { adminReturnDto, returnStatusValues, type AdminReturnDto } from '@store/shared/dto/return';
import { serialize } from '@store/shared/dto/serialize';
import { money, prorate, subtract, ZERO, add, type Money } from '@store/shared/money';

import { writeAudit } from '../audit/write-audit.ts';
import { AdminNotFoundError } from '../catalog-admin/errors.ts';
import { DomainError } from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { reserveAdminRefund } from '../orders-admin/refund.ts';
import type { ProviderMap } from '../payments/refunds.ts';

export class ReturnStateError extends DomainError {
  constructor(message: string) {
    super('RETURN_STATE', message);
  }
}

const note = z
  .string()
  .max(2000)
  .transform((value) =>
    value
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
      .trim(),
  )
  .pipe(z.string().max(1000))
  .transform((value) => (value === '' ? null : value));

export const approveSchema = z.object({
  id: z.uuid(),
  restock: z.boolean(),
  /** Whole kopiykas; omitted = the suggested amount (the paid price of the returned units). */
  refundAmount: z.number().int().min(0).max(100_000_000).optional(),
  note: note.optional(),
});
export const rejectSchema = z.object({ id: z.uuid(), note });
export const receiveSchema = z.object({
  id: z.uuid(),
  items: z
    .array(z.object({ itemId: z.uuid(), receivedQuantity: z.number().int().min(0).max(99) }))
    .min(1)
    .max(50),
});
export const idSchema = z.object({ id: z.uuid() });

type Row = {
  id: string;
  order_id: string;
  status: string;
  restock: boolean;
  refund_amount: number | null;
  refund_operation_id: string | null;
  request_number: string;
};

async function lockReturn(tx: Tx, id: string): Promise<Row> {
  // One actor at a time per return: parallel decisions queue instead of interleaving.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`return:${id}`}, 0))`);
  const found = await tx.execute<Row>(
    sql`SELECT id, order_id, status, restock, refund_amount, refund_operation_id, request_number
          FROM return_requests WHERE id = ${id}::uuid`,
  );
  const row = found.rows[0];
  if (row === undefined) throw new AdminNotFoundError('order');
  return row;
}

/**
 * What the returned units are worth: per order line `prorate(line_total, cumulative, ordered)` minus the same for
 * the units earlier returns of that line already covered, so several partial returns add up to EXACTLY the line total
 * (never `floor(a) + floor(b)` losing kopiykas). `basis` picks the units: what was REQUESTED (the ceiling agreed at
 * approval) or what was actually RECEIVED (what a refund may pay). Earlier means created before this return.
 */
async function proratedRefund(
  reader: Reader,
  id: string,
  basis: 'requested' | 'received',
): Promise<Money> {
  const column = basis === 'received' ? sql.raw('received_quantity') : sql.raw('quantity');
  const result = await reader.execute<{
    line_total: number;
    ordered: number;
    units: number;
    prior: number;
  }>(
    sql`SELECT i.line_total, i.quantity AS ordered, ri.${column} AS units,
               coalesce((SELECT sum(o2.${column})::int
                           FROM return_request_items o2 JOIN return_requests r2 ON r2.id = o2.return_request_id
                          WHERE o2.order_item_id = ri.order_item_id AND r2.status <> 'rejected'
                            AND (r2.created_at, r2.id) < (r.created_at, r.id)), 0)::int AS prior
          FROM return_request_items ri
          JOIN return_requests r ON r.id = ri.return_request_id
          JOIN order_items i ON i.id = ri.order_item_id
         WHERE ri.return_request_id = ${id}::uuid AND ri.${column} > 0`,
  );
  return result.rows.reduce(
    (total, row) =>
      add(
        total,
        subtract(
          prorate(money(row.line_total), row.prior + row.units, row.ordered),
          prorate(money(row.line_total), row.prior, row.ordered),
        ),
      ),
    ZERO,
  );
}

const suggestedRefund = async (reader: Reader, id: string): Promise<Money> =>
  await proratedRefund(reader, id, 'requested');

export async function listReturns(
  reader: Reader,
  filter: 'open' | 'done',
): Promise<
  {
    id: string;
    requestNumber: string;
    orderNumber: string;
    status: (typeof returnStatusValues)[number];
    createdAt: string;
  }[]
> {
  const where =
    filter === 'open'
      ? sql`r.status IN ('requested', 'approved', 'in_transit', 'received')`
      : sql`r.status IN ('rejected', 'refunded', 'closed')`;
  const rows = await reader.execute<{
    id: string;
    request_number: string;
    order_number: string;
    status: string;
    created_at: Date;
  }>(
    sql`SELECT r.id, r.request_number, o.order_number, r.status, r.created_at
          FROM return_requests r JOIN orders o ON o.id = r.order_id
         WHERE ${where} ORDER BY r.created_at, r.id LIMIT 100`,
  );
  return rows.rows.map((r) => ({
    id: r.id,
    requestNumber: r.request_number,
    orderNumber: r.order_number,
    status: z.enum(returnStatusValues).parse(r.status),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function getReturn(reader: Reader, id: string): Promise<AdminReturnDto | null> {
  const found = await reader.execute<{
    id: string;
    request_number: string;
    order_id: string;
    order_number: string;
    email: string | null;
    status: string;
    reason: string;
    customer_comment: string | null;
    admin_note: string | null;
    policy_version: string;
    refund_amount: number | null;
    restock: boolean;
    refund_state: string | null;
    created_at: Date;
  }>(
    sql`SELECT r.id, r.request_number, r.order_id, o.order_number, c.email, r.status, r.reason, r.customer_comment,
               r.admin_note, r.policy_version, r.refund_amount, r.restock, f.state AS refund_state, r.created_at
          FROM return_requests r JOIN orders o ON o.id = r.order_id
          LEFT JOIN customers c ON c.id = r.customer_id
          LEFT JOIN refund_operations f ON f.id = r.refund_operation_id
         WHERE r.id = ${id}::uuid`,
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  const items = await reader.execute<{
    id: string;
    name: string;
    size_label: string;
    quantity: number;
    received: number;
    restocked: number;
  }>(
    sql`SELECT ri.id, i.name_snapshot AS name, i.size_label, ri.quantity, ri.received_quantity AS received,
               ri.restocked_quantity AS restocked
          FROM return_request_items ri JOIN order_items i ON i.id = ri.order_item_id
         WHERE ri.return_request_id = ${id}::uuid ORDER BY i.id`,
  );
  return serialize(adminReturnDto, {
    id: row.id,
    requestNumber: row.request_number,
    orderId: row.order_id,
    orderNumber: row.order_number,
    customerEmail: row.email,
    status: row.status,
    reason: row.reason,
    customerComment: row.customer_comment,
    adminNote: row.admin_note,
    policyVersion: row.policy_version,
    refundAmount: row.refund_amount,
    suggestedRefund: await suggestedRefund(reader, id),
    restock: row.restock,
    refundState: row.refund_state,
    createdAt: new Date(row.created_at).toISOString(),
    items: items.rows.map((i) => ({
      id: i.id,
      name: i.name,
      sizeLabel: i.size_label,
      quantity: i.quantity,
      receivedQuantity: i.received,
      restockedQuantity: i.restocked,
    })),
  });
}

/** requested -> approved: records whether the units go back on the shelf and how much is refunded. */
export async function approveReturn(
  tx: Tx,
  actor: { userId: string },
  input: z.output<typeof approveSchema>,
): Promise<{ orderId: string; refundAmount: number }> {
  const row = await lockReturn(tx, input.id);
  if (row.status !== 'requested') throw new ReturnStateError('only a new request can be approved');
  const suggested = await suggestedRefund(tx, input.id);
  // Never more than the returned units are worth: a goodwill amount above that is a manual refund on the order
  // (with its own permission and reason), not something a return approval can grant.
  if (input.refundAmount !== undefined && input.refundAmount > suggested) {
    throw new ReturnStateError('the amount is more than the returned units are worth');
  }
  const amount = input.refundAmount ?? suggested;
  // Never more than the order still holds: the refund flow checks the budget again when the money moves.
  const budget = await tx.execute<{ left: number }>(
    sql`SELECT (captured_total - refunded_total)::int AS left FROM orders WHERE id = ${row.order_id}::uuid`,
  );
  const left = budget.rows[0]?.left ?? 0;
  if (left > 0 && amount > left) {
    throw new ReturnStateError('the amount is more than the order still holds');
  }
  const updated = await tx.execute(
    sql`UPDATE return_requests
           SET status = 'approved', restock = ${input.restock}, refund_amount = ${amount},
               admin_note = coalesce(${input.note ?? null}, admin_note), resolved_by_user_id = ${actor.userId}::uuid,
               resolved_at = now(), updated_at = now()
         WHERE id = ${input.id}::uuid AND status = 'requested'`,
  );
  if ((updated.rowCount ?? 0) !== 1) throw new ReturnStateError('the request changed meanwhile');
  return { orderId: row.order_id, refundAmount: amount };
}

/** requested or approved -> rejected. A refused request never touched stock or money. */
export async function rejectReturn(
  tx: Tx,
  actor: { userId: string },
  input: z.output<typeof rejectSchema>,
): Promise<{ from: string }> {
  const row = await lockReturn(tx, input.id);
  if (row.status !== 'requested' && row.status !== 'approved') {
    throw new ReturnStateError('this request can no longer be refused');
  }
  const updated = await tx.execute(
    sql`UPDATE return_requests
           SET status = 'rejected', admin_note = coalesce(${input.note}, admin_note),
               resolved_by_user_id = ${actor.userId}::uuid, resolved_at = now(), updated_at = now()
         WHERE id = ${input.id}::uuid AND status IN ('requested', 'approved') AND received_at IS NULL`,
  );
  if ((updated.rowCount ?? 0) !== 1) throw new ReturnStateError('the request changed meanwhile');
  return { from: row.status };
}

export interface ReceiveResult {
  /** Units newly received in this call (the difference to what was already recorded). */
  received: number;
  /** Units put back on the shelf in this call. */
  restocked: number;
  changed: boolean;
}

/**
 * The physical receipt. `receivedQuantity` is the TOTAL now at the warehouse per line (never lower than
 * recorded, never above what was requested); only the difference is applied, once.
 */
export async function receiveReturn(
  tx: Tx,
  actor: { userId: string },
  input: z.output<typeof receiveSchema>,
): Promise<ReceiveResult> {
  // The per-return lock comes FIRST in every operation (receive, refund, close, decide): the advisory lock
  // sits above the ADR-22 row locks, so receive and refund of one return can never lock in opposite orders.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`return:${input.id}`}, 0))`);
  const header = await tx.execute<{ order_id: string }>(
    sql`SELECT order_id FROM return_requests WHERE id = ${input.id}::uuid`,
  );
  const orderId = header.rows[0]?.order_id;
  if (orderId === undefined) throw new AdminNotFoundError('order');
  const lineRows = await tx.execute<{
    id: string;
    order_item_id: string;
    variant_id: string | null;
  }>(
    sql`SELECT ri.id, ri.order_item_id, i.variant_id
          FROM return_request_items ri JOIN order_items i ON i.id = ri.order_item_id
         WHERE ri.return_request_id = ${input.id}::uuid`,
  );
  // ADR-22: the order (3), the order lines (4) ascending, the variants (8) ascending: all before the first change.
  await acquireLocks(tx, {
    orders: [orderId],
    order_items: lineRows.rows.map((r) => r.order_item_id),
    product_variants: lineRows.rows.flatMap((r) => (r.variant_id === null ? [] : [r.variant_id])),
  });
  const row = await lockReturn(tx, input.id);
  if (!['approved', 'in_transit', 'received'].includes(row.status)) {
    throw new ReturnStateError('only an approved return can be received');
  }
  // The refund is computed from what was received: once one is started the receipt can no longer change.
  if (row.refund_operation_id !== null) {
    throw new ReturnStateError('a refund was already started for this return');
  }
  const byId = new Map(lineRows.rows.map((r) => [r.id, r]));
  let received = 0;
  let restocked = 0;
  for (const item of [...input.items].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    const line = byId.get(item.itemId);
    if (line === undefined) throw new ReturnStateError('a line does not belong to this return');
    const current = await tx.execute<{ received: number; restocked: number; quantity: number }>(
      sql`SELECT received_quantity AS received, restocked_quantity AS restocked, quantity
            FROM return_request_items WHERE id = ${item.itemId}::uuid`,
    );
    const before = current.rows[0];
    if (before === undefined) throw new ReturnStateError('a line does not belong to this return');
    if (item.receivedQuantity < before.received || item.receivedQuantity > before.quantity) {
      throw new ReturnStateError(
        'the received quantity is below what was recorded or above what was requested',
      );
    }
    const delta = item.receivedQuantity - before.received;
    if (delta === 0) continue;
    const putBack = row.restock && line.variant_id !== null ? delta : 0;
    // Conditional on the value read under the lock: a concurrent receipt of the same line applies once.
    const moved = await tx.execute(
      sql`UPDATE return_request_items
             SET received_quantity = ${item.receivedQuantity}, restocked_quantity = restocked_quantity + ${putBack}
           WHERE id = ${item.itemId}::uuid AND received_quantity = ${before.received}`,
    );
    if ((moved.rowCount ?? 0) !== 1) throw new ReturnStateError('the line changed meanwhile');
    received += delta;
    if (putBack > 0 && line.variant_id !== null) {
      // ONE atomic increment, never read-modify-write (AGENTS.md section 2.4).
      const stock = await tx.execute<{ after: number }>(
        sql`UPDATE product_variants SET stock_quantity = stock_quantity + ${putBack}
             WHERE id = ${line.variant_id}::uuid RETURNING stock_quantity AS after`,
      );
      const after = stock.rows[0]?.after;
      if (after === undefined) throw new ReturnStateError('the variant no longer exists');
      await tx.execute(
        sql`INSERT INTO stock_adjustments (variant_id, user_id, reason, delta, quantity_before, quantity_after, note)
            VALUES (${line.variant_id}::uuid, ${actor.userId}::uuid, 'return', ${putBack}, ${after - putBack}, ${after},
                    ${`return ${row.request_number}`})`,
      );
      restocked += putBack;
    }
  }
  if (received === 0) return { received: 0, restocked: 0, changed: false };
  await tx.execute(
    sql`UPDATE return_requests
           SET status = 'received', received_at = coalesce(received_at, now()), updated_at = now()
         WHERE id = ${input.id}::uuid AND status IN ('approved', 'in_transit', 'received')`,
  );
  return { received, restocked, changed: true };
}

/** A UUID derived from the return and the attempt: a retry after a FAILED refund must not collapse into the failed one. */
function attemptRequestId(returnId: string, attempt: number): string {
  if (attempt === 0) return returnId;
  const hex = createHash('sha256')
    .update(`${returnId}:${String(attempt)}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Reserves the refund of a RECEIVED return in the phase 5 refund flow. The amount is decided HERE, from what was
 * actually received (never from the request): `min(the amount agreed at approval, the proration of the received
 * units)`, so one received unit of three refunds one third. At most one LIVE operation per return: a claim under the
 * per-return lock plus partial unique indexes on both sides; the order's refund budget still bounds the money, so a
 * return and a hand-made refund cannot both pay it. A refund that FAILED is released (nothing was paid) and the
 * manager may retry with a new request id; one that is pending, in flight, unknown or succeeded blocks any new one.
 * The caller commits, then sends the operation (`processRefund`), exactly as for a manual refund.
 */
export async function reserveReturnRefund(
  tx: Tx,
  actor: { userId: string },
  input: { id: string; providers: ProviderMap },
): Promise<{ operationIds: string[]; amount: number }> {
  const row = await lockReturn(tx, input.id);
  if (row.status !== 'received')
    throw new ReturnStateError('refund a return only after it was received');
  if (row.refund_operation_id !== null) {
    const linked = await tx.execute<{ state: string }>(
      sql`SELECT state FROM refund_operations WHERE id = ${row.refund_operation_id}::uuid`,
    );
    if (linked.rows[0]?.state !== 'failed')
      throw new ReturnStateError('this return already has a refund');
    await tx.execute(
      sql`UPDATE return_requests SET refund_operation_id = NULL, updated_at = now() WHERE id = ${input.id}::uuid`,
    );
  }
  const attempts = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM refund_operations WHERE return_request_id = ${input.id}::uuid`,
  );
  const due = await proratedRefund(tx, input.id, 'received');
  const amount = Math.min(row.refund_amount ?? 0, due);
  if (amount <= 0) throw new ReturnStateError('there is no amount to refund');
  const reservations = await reserveAdminRefund(tx, {
    orderId: row.order_id,
    amount: money(amount),
    reason: `return ${row.request_number}`,
    requestId: attemptRequestId(input.id, attempts.rows[0]?.n ?? 0),
    actorUserId: actor.userId,
    providers: input.providers,
  });
  const first = reservations[0];
  if (reservations.length !== 1 || first === undefined) {
    throw new ReturnStateError('the refund must be made on one payment');
  }
  await tx.execute(
    sql`UPDATE refund_operations SET return_request_id = ${input.id}::uuid WHERE id = ${first.operationId}::uuid`,
  );
  const claimed = await tx.execute(
    sql`UPDATE return_requests SET refund_operation_id = ${first.operationId}::uuid, updated_at = now()
         WHERE id = ${input.id}::uuid AND refund_operation_id IS NULL`,
  );
  if ((claimed.rowCount ?? 0) !== 1) throw new ReturnStateError('this return already has a refund');
  return { operationIds: [first.operationId], amount };
}

/**
 * received -> refunded once the refund operation SUCCEEDED (the provider's answer, never the browser's). Writes its
 * own audit row (`return.refunded`), so a status change is never silent. `actorUserId` is null for the worker.
 */
export async function syncReturnRefund(
  tx: Tx,
  id: string,
  actorUserId: string | null = null,
): Promise<boolean> {
  const updated = await tx.execute(
    sql`UPDATE return_requests r SET status = 'refunded', updated_at = now()
          FROM refund_operations f
         WHERE r.id = ${id}::uuid AND f.id = r.refund_operation_id AND f.state = 'succeeded' AND r.status = 'received'`,
  );
  const changed = (updated.rowCount ?? 0) > 0;
  if (changed) {
    await writeAudit(tx, {
      userId: actorUserId,
      action: 'return.refunded',
      entity: 'return_request',
      entityId: id,
    });
  }
  return changed;
}

/** The worker's sweep: every received return whose refund SUCCEEDED becomes refunded (audited). Returns the ids. */
export async function syncAllReturnRefunds(tx: Tx): Promise<string[]> {
  const due = await tx.execute<{ id: string }>(
    sql`SELECT r.id FROM return_requests r JOIN refund_operations f ON f.id = r.refund_operation_id
         WHERE r.status = 'received' AND f.state = 'succeeded' ORDER BY r.id LIMIT 200`,
  );
  const done: string[] = [];
  for (const row of due.rows) {
    if (await syncReturnRefund(tx, row.id)) done.push(row.id);
  }
  return done;
}

/** received -> closed without a refund through the system (cash on delivery, the money settled outside, or a FAILED refund given up). */
export async function closeReturn(tx: Tx, actor: { userId: string }, id: string): Promise<void> {
  const row = await lockReturn(tx, id);
  if (row.status !== 'received') throw new ReturnStateError('only a received return can be closed');
  if (row.refund_operation_id !== null) {
    const linked = await tx.execute<{ state: string }>(
      sql`SELECT state FROM refund_operations WHERE id = ${row.refund_operation_id}::uuid`,
    );
    if (linked.rows[0]?.state !== 'failed') {
      throw new ReturnStateError('a return with a live refund cannot be closed');
    }
  }
  await tx.execute(
    sql`UPDATE return_requests SET status = 'closed', resolved_by_user_id = ${actor.userId}::uuid, resolved_at = now(), updated_at = now()
         WHERE id = ${id}::uuid AND status = 'received'`,
  );
}
