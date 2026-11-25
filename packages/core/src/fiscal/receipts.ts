/**
 * Fiscal receipts (ADR-16). Fiscalisation NEVER blocks a payment or a shipment: the sale that
 * confirms the payment (or ships the COD parcel) writes a `pending` fiscal document and an outbox
 * row in the SAME transaction, and a queue job issues the receipt afterwards, with retries.
 *
 * Which receipt, and when (accountant's answer 2026-10-26):
 *  - card online (mono, wayforpay): a sale receipt after the verified payment;
 *  - cash on delivery: a sale receipt for the GOODS with the payment form "cash on delivery", when
 *    the parcel is handed to the post (shipOrder); the carrier's own receipt is not ours;
 *  - bank transfer to the IBAN: no receipt (`fiscal_status = not_required`);
 *  - a refund: a return receipt that points at the primary one (`parent_document_id`).
 *
 * Callers hold the order lock (ADR-22), so a document is created once per order and kind.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { fiscalDocuments, orderItems, orders, outbox } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { allocate, money, multiply, subtract, sum, ZERO, type Money } from '@store/shared/money';

/** A receipt line: a price in kopiykas (`Money`) and whole units. */
export interface ReceiptLine {
  code: string;
  name: string;
  unitPrice: Money;
  quantity: number;
}

/**
 * What is stored in `fiscal_documents.items_snapshot`: read back through this, never trusted as
 * is. The JSON holds plain integers; they become `Money` here, at the boundary.
 */
export const receiptSnapshotSchema = z.object({
  paymentForm: z.enum(['card', 'cash_on_delivery']),
  items: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      unitPrice: z
        .number()
        .int()
        .positive()
        .transform((value) => money(value)),
      quantity: z.number().int().positive(),
    }),
  ),
});

export type ReceiptSnapshot = z.infer<typeof receiptSnapshotSchema>;

type OrderRow = Pick<typeof orders.$inferSelect, 'shippingTotal' | 'adjustmentTotal'>;
type ItemRow = Pick<
  typeof orderItems.$inferSelect,
  'nameSnapshot' | 'colorName' | 'sizeLabel' | 'skuSnapshot' | 'quantity' | 'lineTotal'
>;

/** A line total split into `quantity` equal units, or one unit named with the quantity. */
function toLine(item: ItemRow, name: string, total: Money): ReceiptLine {
  const units = allocate(
    total,
    Array.from({ length: item.quantity }, () => total),
  );
  const first = units[0];
  if (first !== undefined && units.every((unit) => unit === first)) {
    return { code: item.skuSnapshot, name, unitPrice: first, quantity: item.quantity };
  }
  return {
    code: item.skuSnapshot,
    name: `${name} x ${String(item.quantity)}`,
    unitPrice: total,
    quantity: 1,
  };
}

/**
 * Receipt lines from the order's items, delivery and adjustment. The receipt total must equal what
 * the buyer paid (`orders.total`), so:
 *  - the DISCOUNT is spread into unit prices (the line total after discount): a line whose total
 *    divides by its quantity keeps the quantity; one that does not becomes a single unit named
 *    with its quantity, so no kopiyka is invented or lost;
 *  - a POSITIVE adjustment is a line of its own;
 *  - a NEGATIVE adjustment (a compensation) is spread over the goods lines in proportion to their
 *    totals (`allocate`), because a receipt line cannot carry a negative price.
 * Returns an empty list when no valid receipt can be built (the compensation swallows the goods).
 */
export function buildReceiptLines(order: OrderRow, items: readonly ItemRow[]): ReceiptLine[] {
  let totals = items.map((item) => money(item.lineTotal));
  if (order.adjustmentTotal < 0) {
    const reduction = money(-order.adjustmentTotal);
    if (totals.length === 0 || reduction >= sum(totals)) return [];
    const shares = allocate(reduction, totals);
    totals = totals.map((total, index) => subtract(total, shares[index] ?? ZERO));
  }
  const lines: ReceiptLine[] = [];
  items.forEach((item, index) => {
    const total = totals[index] ?? ZERO;
    if (total <= 0 || item.quantity <= 0) return;
    const name = [item.nameSnapshot, item.colorName, item.sizeLabel]
      .filter((part) => part !== '')
      .join(', ');
    lines.push(toLine(item, name, total));
  });
  if (order.shippingTotal > 0) {
    lines.push({
      code: 'DELIVERY',
      name: 'Delivery',
      unitPrice: money(order.shippingTotal),
      quantity: 1,
    });
  }
  if (order.adjustmentTotal > 0) {
    lines.push({
      code: 'ADJUSTMENT',
      name: 'Adjustment',
      unitPrice: money(order.adjustmentTotal),
      quantity: 1,
    });
  }
  return lines;
}

export const lineTotalOf = (lines: readonly ReceiptLine[]): Money =>
  sum(lines.map((line) => multiply(line.unitPrice, line.quantity)));

export type EnqueueResult = 'queued' | 'exists' | 'not_required' | 'failed';

async function queue(tx: Tx, documentId: string): Promise<void> {
  await tx
    .insert(outbox)
    .values({
      topic: 'fiscal.issue-receipt',
      // The id only: the receipt's content is read from the database by the job.
      payload: { documentId },
      dedupKey: `fiscal:${documentId}`,
    })
    .onConflictDoNothing();
}

/**
 * The lines do not add up to what the buyer paid: the document is written `failed` with the
 * reason, the order says so and ONE alert is queued. It must never throw: this runs inside the
 * payment's transaction, and a fiscal problem must not undo a payment (ADR-16).
 */
async function recordUnbuildable(
  tx: Tx,
  order: typeof orders.$inferSelect,
  reason: string,
): Promise<EnqueueResult> {
  const [document] = await tx
    .insert(fiscalDocuments)
    .values({
      orderId: order.id,
      kind: 'sale',
      provider: 'checkbox',
      amount: order.total,
      state: 'failed',
      lastError: reason,
    })
    // `fiscal_docs_one_sale_uq`: a sale document already exists, so this one changes nothing.
    .onConflictDoNothing({
      target: fiscalDocuments.orderId,
      where: sql`${fiscalDocuments.kind} = 'sale'`,
    })
    .returning({ id: fiscalDocuments.id });
  if (document === undefined) return 'exists';
  await tx
    .update(orders)
    .set({ fiscalStatus: 'failed', fiscalError: reason })
    .where(eq(orders.id, order.id));
  await tx
    .insert(outbox)
    .values({
      topic: 'alert.fiscal-failed',
      payload: { orderId: order.id, documentId: document.id },
      dedupKey: `fiscal-failed:order:${order.id}`,
    })
    .onConflictDoNothing();
  return 'failed';
}

/**
 * Writes the pending sale document and its queue message. Call under the order lock, in the
 * transaction that confirmed the payment or shipped the parcel.
 */
export async function enqueueSaleReceipt(
  tx: Tx,
  input: { orderId: string; paymentForm: ReceiptSnapshot['paymentForm'] },
): Promise<EnqueueResult> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (order === undefined) throw new Error(`order ${input.orderId} vanished`);
  if (order.paymentProvider === 'bank_transfer') {
    await tx.update(orders).set({ fiscalStatus: 'not_required' }).where(eq(orders.id, order.id));
    return 'not_required';
  }
  const [existing] = await tx
    .select({ id: fiscalDocuments.id })
    .from(fiscalDocuments)
    .where(and(eq(fiscalDocuments.orderId, order.id), eq(fiscalDocuments.kind, 'sale')));
  if (existing !== undefined) return 'exists';

  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  const lines = buildReceiptLines(order, items);
  if (lines.length === 0 || lineTotalOf(lines) !== money(order.total)) {
    return await recordUnbuildable(tx, order, 'the receipt lines do not add up to the order total');
  }
  const snapshot: ReceiptSnapshot = { paymentForm: input.paymentForm, items: lines };
  const [document] = await tx
    .insert(fiscalDocuments)
    .values({
      orderId: order.id,
      kind: 'sale',
      provider: 'checkbox',
      amount: order.total,
      itemsSnapshot: snapshot,
    })
    // The unique index is the guarantee; the select above only saves the work in the common case.
    .onConflictDoNothing({
      target: fiscalDocuments.orderId,
      where: sql`${fiscalDocuments.kind} = 'sale'`,
    })
    .returning({ id: fiscalDocuments.id });
  if (document === undefined) return 'exists';
  await tx.update(orders).set({ fiscalStatus: 'pending' }).where(eq(orders.id, order.id));
  await queue(tx, document.id);
  return 'queued';
}

/**
 * A return receipt for a succeeded refund, pointing at the primary sale receipt. Orders without a
 * sale document (COD that never shipped, bank transfer) have nothing to return and get none.
 * Full refund: the sale's lines. Partial refund: one line for the refunded amount.
 */
export async function enqueueReturnReceipt(
  tx: Tx,
  input: { orderId: string; refundOperationId: string; amount: Money },
): Promise<EnqueueResult> {
  const [sale] = await tx
    .select()
    .from(fiscalDocuments)
    .where(and(eq(fiscalDocuments.orderId, input.orderId), eq(fiscalDocuments.kind, 'sale')));
  if (sale === undefined) return 'not_required';
  const [existing] = await tx
    .select({ id: fiscalDocuments.id })
    .from(fiscalDocuments)
    .where(eq(fiscalDocuments.refundOperationId, input.refundOperationId));
  if (existing !== undefined) return 'exists';

  const parsed = receiptSnapshotSchema.safeParse(sale.itemsSnapshot);
  const paymentForm = parsed.success ? parsed.data.paymentForm : 'card';
  const items: ReceiptLine[] =
    parsed.success && input.amount === money(sale.amount)
      ? parsed.data.items
      : [{ code: 'REFUND', name: 'Refund', unitPrice: input.amount, quantity: 1 }];
  const snapshot: ReceiptSnapshot = { paymentForm, items };
  const [document] = await tx
    .insert(fiscalDocuments)
    .values({
      orderId: input.orderId,
      kind: 'return',
      parentDocumentId: sale.id,
      refundOperationId: input.refundOperationId,
      provider: 'checkbox',
      amount: input.amount,
      itemsSnapshot: snapshot,
    })
    // `fiscal_docs_one_return_per_refund_uq`.
    .onConflictDoNothing({
      target: fiscalDocuments.refundOperationId,
      where: sql`${fiscalDocuments.refundOperationId} IS NOT NULL`,
    })
    .returning({ id: fiscalDocuments.id });
  if (document === undefined) return 'exists';
  await queue(tx, document.id);
  return 'queued';
}
