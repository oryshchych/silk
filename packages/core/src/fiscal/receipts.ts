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
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { fiscalDocuments, orderItems, orders, outbox } from '@store/db/schema';
import type { Tx } from '@store/db/types';

/** A receipt line in kopiykas and whole units (plain numbers: the snapshot is stored as JSON). */
export interface ReceiptLine {
  code: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

/** What is stored in `fiscal_documents.items_snapshot`: read back through this, never trusted as is. */
export const receiptSnapshotSchema = z.object({
  paymentForm: z.enum(['card', 'cash_on_delivery']),
  items: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      unitPrice: z.number().int().positive(),
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

/**
 * Receipt lines from the order's items, delivery and adjustment. The receipt total must equal what
 * the buyer paid, so the DISCOUNT is spread into unit prices (the line total after discount): a
 * line whose total divides by its quantity keeps the quantity; one that does not becomes a single
 * unit named with its quantity, so no kopiyka is invented or lost.
 */
export function buildReceiptLines(order: OrderRow, items: readonly ItemRow[]): ReceiptLine[] {
  const lines: ReceiptLine[] = items.map((item) => {
    const name = [item.nameSnapshot, item.colorName, item.sizeLabel]
      .filter((part) => part !== '')
      .join(', ');
    if (item.quantity > 0 && item.lineTotal % item.quantity === 0) {
      return {
        code: item.skuSnapshot,
        name,
        unitPrice: item.lineTotal / item.quantity,
        quantity: item.quantity,
      };
    }
    return {
      code: item.skuSnapshot,
      name: `${name} x ${String(item.quantity)}`,
      unitPrice: item.lineTotal,
      quantity: 1,
    };
  });
  if (order.shippingTotal > 0) {
    lines.push({ code: 'DELIVERY', name: 'Delivery', unitPrice: order.shippingTotal, quantity: 1 });
  }
  if (order.adjustmentTotal > 0) {
    lines.push({
      code: 'ADJUSTMENT',
      name: 'Adjustment',
      unitPrice: order.adjustmentTotal,
      quantity: 1,
    });
  }
  return lines;
}

export const lineTotalOf = (lines: readonly ReceiptLine[]): number =>
  lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0);

export type EnqueueResult = 'queued' | 'exists' | 'not_required';

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
    .returning({ id: fiscalDocuments.id });
  if (document === undefined) throw new Error('fiscal document insert returned no row');
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
  input: { orderId: string; refundOperationId: string; amount: number },
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
    parsed.success && input.amount === sale.amount
      ? parsed.data.items
      : [{ code: 'REFUND', name: 'Refund', unitPrice: input.amount, quantity: 1 }];
  const [document] = await tx
    .insert(fiscalDocuments)
    .values({
      orderId: input.orderId,
      kind: 'return',
      parentDocumentId: sale.id,
      refundOperationId: input.refundOperationId,
      provider: 'checkbox',
      amount: input.amount,
      itemsSnapshot: { paymentForm, items } satisfies ReceiptSnapshot,
    })
    .returning({ id: fiscalDocuments.id });
  if (document === undefined) throw new Error('fiscal document insert returned no row');
  await queue(tx, document.id);
  return 'queued';
}
