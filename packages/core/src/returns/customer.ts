/**
 * A customer's return request. Eligibility is decided HERE from the database, never from the request:
 * the order is the session's customer's own (`orders.customer_id`), it was DELIVERED, and the database
 * clock is inside the window (`settings.return_window_days`, default 14 days after delivery: an owner
 * decision, Q71). The units asked for are capped by what was ordered minus what earlier non-refused
 * requests already hold, counted under the order and order-line locks (ADR-22), so two parallel requests
 * for the same unit cannot both succeed. Nothing here touches stock or money: that happens when the
 * return is RECEIVED and refunded (`returns/admin.ts`, ADR-18).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader, Tx } from '@store/db/types';
import {
  customerReturnDto,
  eligibleOrderDto,
  returnReasonValues,
  type CustomerReturnDto,
  type EligibleOrderDto,
} from '@store/shared/dto/return';
import { serialize } from '@store/shared/dto/serialize';
import { isReasonAccepted, RETURN_POLICY } from '@store/shared/return-policy';

import { writeAudit } from '../audit/write-audit.ts';
import { DomainError } from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { currentPolicyRef } from '../legal/read.ts';
import { normalizeOrderNumber } from '../orders/lookup.ts';

/** From the shared policy (`@store/shared/return-policy`), the same constants the page, the form and the JSON-LD use. */
export const DEFAULT_WINDOW_DAYS = RETURN_POLICY.defaultWindowDays;
export const MAX_OPEN_REQUESTS = 5;
const OPEN = "('requested', 'approved', 'in_transit', 'received')";

export class ReturnNotEligibleError extends DomainError {
  constructor() {
    super('RETURN_NOT_ELIGIBLE', 'This order cannot be returned');
  }
}
export class ReturnReasonNotAcceptedError extends DomainError {
  constructor() {
    super('RETURN_REASON', 'This reason is not accepted for a return');
  }
}
export class ReturnItemsInvalidError extends DomainError {
  constructor() {
    super('RETURN_ITEMS', 'These items cannot be returned in this quantity');
  }
}
export class ReturnLimitError extends DomainError {
  constructor() {
    super('RETURN_LIMIT', 'Too many open return requests');
  }
}

const plain = z
  .string()
  .max(2000)
  .transform((value) =>
    value
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      // A bidirectional override would reorder a line visually even though the text is escaped.
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
      .trim(),
  )
  .pipe(z.string().max(1000))
  .transform((value) => (value === '' ? null : value));

export const returnInputSchema = z.object({
  orderNumber: z.string().min(1).max(40),
  reason: z.enum(returnReasonValues),
  comment: plain,
  items: z
    .array(z.object({ orderItemId: z.uuid(), quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50)
    .refine(
      (items) => new Set(items.map((i) => i.orderItemId)).size === items.length,
      'one line once',
    ),
});
export type ReturnInput = z.output<typeof returnInputSchema>;

/** Days after delivery; the setting wins when it is a sane number, the default otherwise. */
export async function returnWindowDays(reader: Reader): Promise<number> {
  const result = await reader.execute<{ value: unknown }>(
    sql`SELECT value FROM settings WHERE key = 'return_window_days'`,
  );
  const value = result.rows[0]?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365
    ? value
    : DEFAULT_WINDOW_DAYS;
}

interface Who {
  customerId: string;
  userId: string;
  ip: string | null;
}

/** My delivered orders still inside the window, with the units that can still be returned. */
export async function listEligibleOrders(
  reader: Reader,
  customerId: string,
): Promise<EligibleOrderDto[]> {
  const days = await returnWindowDays(reader);
  const result = await reader.execute<{
    order_number: string;
    delivered_at: Date;
    deadline: Date;
    item_id: string;
    name: string;
    size_label: string;
    remaining: number;
  }>(
    sql`SELECT o.order_number, o.delivered_at, o.delivered_at + make_interval(days => ${days}) AS deadline,
               i.id AS item_id, i.name_snapshot AS name, i.size_label,
               i.quantity - coalesce((SELECT sum(ri.quantity) FROM return_request_items ri
                                        JOIN return_requests r ON r.id = ri.return_request_id
                                       WHERE ri.order_item_id = i.id AND r.status <> 'rejected'), 0)::int AS remaining
          FROM orders o JOIN order_items i ON i.order_id = o.id
         WHERE o.customer_id = ${customerId}::uuid AND o.status = 'delivered' AND o.delivered_at IS NOT NULL
           AND now() <= o.delivered_at + make_interval(days => ${days})
         ORDER BY o.delivered_at DESC, o.id, i.id`,
  );
  const byOrder = new Map<string, EligibleOrderDto>();
  for (const row of result.rows) {
    if (row.remaining <= 0) continue;
    const entry =
      byOrder.get(row.order_number) ??
      serialize(eligibleOrderDto, {
        orderNumber: row.order_number,
        deliveredAt: new Date(row.delivered_at).toISOString(),
        deadline: new Date(row.deadline).toISOString(),
        items: [],
      });
    entry.items.push({
      orderItemId: row.item_id,
      name: row.name,
      sizeLabel: row.size_label,
      remaining: row.remaining,
    });
    byOrder.set(row.order_number, entry);
  }
  return [...byOrder.values()];
}

export async function createReturnRequest(tx: Tx, who: Who, input: ReturnInput): Promise<string> {
  // The policy (Q75): a request because of a change of mind, a wrong size or "other" is not accepted for
  // underwear and hosiery of proper quality; the form offers only the accepted reasons and this is the server's say.
  if (!isReasonAccepted(input.reason)) throw new ReturnReasonNotAcceptedError();
  const number = normalizeOrderNumber(input.orderNumber);
  if (number === null) throw new ReturnNotEligibleError();
  // My order only: another customer's number is "not eligible", like one that does not exist.
  const found = await tx.execute<{ id: string }>(
    sql`SELECT id FROM orders WHERE order_number = ${number} AND customer_id = ${who.customerId}::uuid`,
  );
  const orderId = found.rows[0]?.id;
  if (orderId === undefined) throw new ReturnNotEligibleError();
  // ADR-22: the order (3), then its lines (4) in ascending id order. Everything below is counted under them.
  await acquireLocks(tx, { orders: [orderId] });
  const lineIds = input.items.map((item) => item.orderItemId);
  const lines = await acquireLocks(tx, { order_items: lineIds });
  const days = await returnWindowDays(tx);
  const eligible = await tx.execute<{ ok: boolean }>(
    sql`SELECT (status = 'delivered' AND delivered_at IS NOT NULL
                AND now() <= delivered_at + make_interval(days => ${days})) AS ok
          FROM orders WHERE id = ${orderId}::uuid`,
  );
  if (eligible.rows[0]?.ok !== true) throw new ReturnNotEligibleError();
  if ((lines.order_items ?? []).length !== lineIds.length) throw new ReturnItemsInvalidError();
  const open = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM return_requests
         WHERE customer_id = ${who.customerId}::uuid AND status IN ${sql.raw(OPEN)}`,
  );
  if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_REQUESTS) throw new ReturnLimitError();
  for (const item of input.items) {
    const left = await tx.execute<{ remaining: number }>(
      sql`SELECT i.quantity - coalesce((SELECT sum(ri.quantity) FROM return_request_items ri
                                          JOIN return_requests r ON r.id = ri.return_request_id
                                         WHERE ri.order_item_id = i.id AND r.status <> 'rejected'), 0)::int AS remaining
            FROM order_items i WHERE i.id = ${item.orderItemId}::uuid AND i.order_id = ${orderId}::uuid`,
    );
    const remaining = left.rows[0]?.remaining;
    if (remaining === undefined || item.quantity > remaining) throw new ReturnItemsInvalidError();
  }
  // The edition of the returns text in force NOW (database clock), in the customer's own language, recorded with the request.
  const owner = await tx.execute<{ locale: string }>(
    sql`SELECT locale FROM customers WHERE id = ${who.customerId}::uuid`,
  );
  const policyRef = await currentPolicyRef(
    tx,
    'returns',
    owner.rows[0]?.locale === 'en' ? 'en' : 'uk',
  );
  const numbered = await tx.execute<{ n: string }>(sql`SELECT next_return_number() AS n`);
  const requestNumber = numbered.rows[0]?.n;
  if (requestNumber === undefined) throw new Error('no return number');
  const created = await tx.execute<{ id: string }>(
    sql`INSERT INTO return_requests (request_number, order_id, customer_id, reason, policy_version, customer_comment)
        VALUES (${requestNumber}, ${orderId}::uuid, ${who.customerId}::uuid, ${input.reason}::return_reason,
                ${policyRef}, ${input.comment}) RETURNING id`,
  );
  const id = created.rows[0]?.id;
  if (id === undefined) throw new Error('return insert returned no row');
  for (const item of input.items) {
    await tx.execute(
      sql`INSERT INTO return_request_items (return_request_id, order_item_id, order_id, quantity)
          VALUES (${id}::uuid, ${item.orderItemId}::uuid, ${orderId}::uuid, ${item.quantity})`,
    );
  }
  // The comment is not copied into the audit row.
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.return_requested',
    entity: 'return_request',
    entityId: id,
    diff: { reason: input.reason, lines: input.items.length },
    ip: who.ip,
  });
  return id;
}

/** MY requests, newest first. Another customer's request is never read (scoped by the session's customer). */
export async function listMyReturns(
  reader: Reader,
  customerId: string,
): Promise<CustomerReturnDto[]> {
  const rows = await reader.execute<{
    id: string;
    request_number: string;
    order_number: string;
    status: string;
    reason: string;
    created_at: Date;
  }>(
    sql`SELECT r.id, r.request_number, o.order_number, r.status, r.reason, r.created_at
          FROM return_requests r JOIN orders o ON o.id = r.order_id
         WHERE r.customer_id = ${customerId}::uuid ORDER BY r.created_at DESC, r.id LIMIT 50`,
  );
  const out: CustomerReturnDto[] = [];
  for (const row of rows.rows) {
    const items = await reader.execute<{
      name: string;
      size_label: string;
      quantity: number;
      received: number;
    }>(
      sql`SELECT i.name_snapshot AS name, i.size_label, ri.quantity, ri.received_quantity AS received
            FROM return_request_items ri JOIN order_items i ON i.id = ri.order_item_id
           WHERE ri.return_request_id = ${row.id}::uuid ORDER BY i.id`,
    );
    out.push(
      serialize(customerReturnDto, {
        requestNumber: row.request_number,
        orderNumber: row.order_number,
        status: row.status,
        reason: row.reason,
        createdAt: new Date(row.created_at).toISOString(),
        items: items.rows.map((i) => ({
          name: i.name,
          sizeLabel: i.size_label,
          quantity: i.quantity,
          receivedQuantity: i.received,
        })),
      }),
    );
  }
  return out;
}
