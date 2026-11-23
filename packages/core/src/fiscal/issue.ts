/**
 * The `fiscal:issue-receipt` job (ADR-16): turns a pending `fiscal_documents` row into a receipt.
 *
 *  1. transaction: lock the order, count the attempt, mark the document `in_flight`;
 *  2. the provider is called with NO transaction open; the receipt id is our `local_reference`, so
 *     a repeat after a lost answer never makes a second receipt, and an `unknown` or `in_flight`
 *     document is LOOKED UP before anything is sent again;
 *  3. transaction: record the outcome.
 *
 * A transient failure throws `FiscalRetryError` (pg-boss retries with backoff). After MAX_ATTEMPTS
 * the document is `failed`, the order gets `fiscal_status = 'failed'` and an alert is queued; a
 * person retries it from the admin (phase 5). The payment itself is never touched.
 */
import { eq, sql } from 'drizzle-orm';

import { fiscalDocuments, orders, outbox } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import type { FiscalItem, FiscalProvider, FiscalResult } from '@store/payments/fiscal';
import { money } from '@store/shared/money';

import { FiscalRetryError } from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { receiptSnapshotSchema } from './receipts.ts';

/** With the queue's exponential backoff (capped at one hour) twelve attempts span about five hours. */
export const MAX_FISCAL_ATTEMPTS = 12;

export interface FiscalDeps {
  runInTransaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  provider: FiscalProvider;
}

export type FiscalOutcome = 'issued' | 'already_issued' | 'failed';

type Document = typeof fiscalDocuments.$inferSelect;

interface Claim {
  document: Document;
  buyerEmail: string;
  parent: { providerId: string; fiscalNumber: string } | null;
  /** True when a previous run may have reached the provider: look before sending. */
  lookFirst: boolean;
}

async function failDocument(tx: Tx, document: Document, error: string): Promise<void> {
  await tx
    .update(fiscalDocuments)
    .set({ state: 'failed', lastError: error.slice(0, 200) })
    .where(eq(fiscalDocuments.id, document.id));
  // A failed RETURN must not overwrite the status of a sale that WAS issued: only the error text
  // says what failed (the gap job lists failed returns by their document).
  await tx
    .update(orders)
    .set(
      document.kind === 'return'
        ? { fiscalError: error.slice(0, 200) }
        : { fiscalStatus: 'failed', fiscalError: error.slice(0, 200) },
    )
    .where(eq(orders.id, document.orderId));
  await tx
    .insert(outbox)
    .values({
      topic: 'alert.fiscal-failed',
      // Ids only: no buyer data in an alert.
      payload: { orderId: document.orderId, documentId: document.id },
      dedupKey: `fiscal-failed:${document.id}`,
    })
    .onConflictDoNothing();
}

/** The attempts ran out: the caller makes ONE last lookup before it gives up. */
interface Exhausted {
  exhausted: Document;
}

async function claim(tx: Tx, documentId: string): Promise<Claim | Exhausted | FiscalOutcome> {
  const [probe] = await tx
    .select({ orderId: fiscalDocuments.orderId })
    .from(fiscalDocuments)
    .where(eq(fiscalDocuments.id, documentId));
  if (probe === undefined) throw new Error(`no such fiscal document ${documentId}`);
  await acquireLocks(tx, { orders: [probe.orderId] });
  const [document] = await tx
    .select()
    .from(fiscalDocuments)
    .where(eq(fiscalDocuments.id, documentId));
  const [order] = await tx.select().from(orders).where(eq(orders.id, probe.orderId));
  if (document === undefined || order === undefined) throw new Error('fiscal document vanished');
  if (document.state === 'succeeded') return 'already_issued';
  if (document.state === 'failed') return 'failed';

  let parent: Claim['parent'] = null;
  if (document.kind === 'return') {
    const [primary] =
      document.parentDocumentId === null
        ? []
        : await tx
            .select()
            .from(fiscalDocuments)
            .where(eq(fiscalDocuments.id, document.parentDocumentId));
    if (primary?.state === 'failed') {
      // Nothing to wait for: the primary receipt is gone for good, a person must look at it.
      await failDocument(tx, document, 'the primary receipt failed');
      return 'failed';
    }
    if (primary === undefined || primary.state !== 'succeeded' || primary.fiscalNumber === null) {
      // The return receipt carries the primary's fiscal number: it waits until that exists.
      throw new FiscalRetryError('the primary receipt is not issued yet');
    }
    parent = { providerId: primary.localReference, fiscalNumber: primary.fiscalNumber };
  }
  if (document.attempts >= MAX_FISCAL_ATTEMPTS) return { exhausted: document };
  await tx
    .update(fiscalDocuments)
    .set({ attempts: document.attempts + 1, state: 'in_flight' })
    .where(eq(fiscalDocuments.id, document.id));
  return {
    document,
    buyerEmail: order.customerEmail,
    parent,
    lookFirst: document.state === 'in_flight' || document.state === 'unknown',
  };
}

async function record(
  tx: Tx,
  document: Document,
  result: FiscalResult,
): Promise<FiscalOutcome | 'retry'> {
  if (result.state === 'issued') {
    await tx
      .update(fiscalDocuments)
      .set({
        state: 'succeeded',
        fiscalNumber: result.fiscalNumber,
        receiptUrl: result.receiptUrl,
        issuedAt: sql`now()`,
        lastError: null,
      })
      .where(eq(fiscalDocuments.id, document.id));
    await tx
      .update(orders)
      .set(
        document.kind === 'sale'
          ? {
              fiscalStatus: 'issued',
              fiscalReceiptId: result.providerId,
              fiscalReceiptUrl: result.receiptUrl,
              fiscalError: null,
            }
          : { fiscalStatus: 'refund_issued' },
      )
      .where(eq(orders.id, document.orderId));
    return 'issued';
  }
  if (result.state === 'failed') {
    await failDocument(tx, document, result.error);
    return 'failed';
  }
  await tx
    .update(fiscalDocuments)
    .set({
      state: result.state === 'unknown' ? 'unknown' : 'in_flight',
      lastError: result.state === 'unknown' ? result.error.slice(0, 200) : null,
    })
    .where(eq(fiscalDocuments.id, document.id));
  return 'retry';
}

export async function issueFiscalReceipt(
  deps: FiscalDeps,
  documentId: string,
): Promise<FiscalOutcome> {
  const claimed = await deps.runInTransaction(async (tx) => await claim(tx, documentId));
  if (typeof claimed === 'string') return claimed;
  if ('exhausted' in claimed) {
    const { exhausted } = claimed;
    // One last look before giving up: the receipt may exist although every answer was lost.
    const found =
      exhausted.state === 'unknown' || exhausted.state === 'in_flight'
        ? await deps.provider.lookup(exhausted.localReference).catch(() => null)
        : null;
    const adopted = found?.found === true && found.result.state === 'issued' ? found.result : null;
    return await deps.runInTransaction(async (tx) => {
      if (adopted !== null)
        return (await record(tx, exhausted, adopted)) === 'issued' ? 'issued' : 'failed';
      await failDocument(tx, exhausted, 'the retries ran out');
      return 'failed';
    });
  }
  const { document, parent } = claimed;
  const snapshot = receiptSnapshotSchema.safeParse(document.itemsSnapshot);
  if (!snapshot.success) {
    await deps.runInTransaction(async (tx) => {
      await failDocument(tx, document, 'the receipt snapshot is unreadable');
    });
    return 'failed';
  }

  let result: FiscalResult | null = null;
  if (claimed.lookFirst) {
    // A previous run may have reached the provider: its answer decides, never a blind resend.
    const found = await deps.provider.lookup(document.localReference);
    if (found.found) result = found.result;
  }
  if (result === null) {
    const items: FiscalItem[] = snapshot.data.items.map((line) => ({
      code: line.code,
      name: line.name,
      unitPrice: money(line.unitPrice),
      quantity: line.quantity,
    }));
    const base = {
      localReference: document.localReference,
      items,
      total: money(document.amount),
      paymentForm: snapshot.data.paymentForm,
      buyerEmail: claimed.buyerEmail,
    };
    result =
      parent === null
        ? await deps.provider.issueSale(base)
        : await deps.provider.issueReturn({
            ...base,
            parentProviderId: parent.providerId,
            parentFiscalNumber: parent.fiscalNumber,
          });
  }
  const settled = result;
  const outcome = await deps.runInTransaction(async (tx) => await record(tx, document, settled));
  if (outcome === 'retry') throw new FiscalRetryError(`the provider answered ${settled.state}`);
  return outcome;
}
