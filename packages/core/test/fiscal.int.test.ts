/**
 * Fiscal receipts on real Postgres (ADR-16, phase 3): a card payment writes a pending document in
 * the webhook's transaction, a job issues the receipt later, a failing provider never touches the
 * payment, COD is fiscalised at shipping, a transfer is not, and a refund makes a return receipt
 * that points at the primary one. The provider is the real Checkbox adapter against a local fake.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { fiscalDocuments, orders } from '@store/db/schema';
import { CheckboxProvider } from '@store/payments/checkbox';
import {
  startFakeCheckbox,
  FAKE_LICENSE,
  FAKE_LOGIN,
  FAKE_PASSWORD,
  type FakeCheckbox,
} from '@store/payments/test/fake-checkbox';
import { WayForPayProvider } from '@store/payments/wayforpay';
import {
  FAKE_ACCOUNT,
  FAKE_SECRET,
  startFakeWayForPay,
  type FakeWayForPay,
} from '@store/payments/test/fake-wayforpay';

import { FiscalRetryError } from '../src/errors.ts';
import { issueFiscalReceipt, MAX_FISCAL_ATTEMPTS, type FiscalDeps } from '../src/fiscal/issue.ts';
import {
  buildReceiptLines,
  enqueueReturnReceipt,
  enqueueSaleReceipt,
  lineTotalOf,
} from '../src/fiscal/receipts.ts';
import { shipOrder } from '../src/orders/fulfilment.ts';
import { confirmCodOrder, confirmTransferReceived } from '../src/payments/offline.ts';
import { handlePaymentWebhook } from '../src/payments/handle-webhook.ts';
import { createPaymentAttempt, recordAttemptResult } from '../src/payments/attempts.ts';
import {
  claimRefund,
  requestFullRefund,
  requestRefund,
  settleRefund,
} from '../src/payments/refunds.ts';
import { money } from '@store/shared/money';

import { acquireLocks } from '../src/locks/acquire-locks.ts';

import { createWorld, type TestWorld } from './fixtures.ts';
import { placeOrder } from './place-order.ts';

let checkbox: FakeCheckbox;
let wfpFake: FakeWayForPay;
let wfp: WayForPayProvider;
let world: TestWorld;
let admin: DbHandle;
let variants: string[];

beforeAll(async () => {
  checkbox = await startFakeCheckbox();
  wfpFake = await startFakeWayForPay();
  wfp = new WayForPayProvider({
    pageHosts: ['secure.example'],
    baseUrl: wfpFake.baseUrl,
    merchantAccount: FAKE_ACCOUNT,
    secretKey: FAKE_SECRET,
    merchantDomainName: 'shop.example',
  });
});
afterAll(async () => {
  await checkbox.close();
  await wfpFake.close();
});
beforeEach(async () => {
  checkbox.receipts.clear();
  checkbox.state.shiftOpen = false;
  checkbox.failNextSell(null);
  world = await createWorld();
  admin = world.connect(2);
  variants = world.fixture.variantIds;
});
afterEach(async () => {
  await world.close();
});

const provider = (): CheckboxProvider =>
  new CheckboxProvider({
    baseUrl: checkbox.baseUrl,
    licenseKey: FAKE_LICENSE,
    cashierLogin: FAKE_LOGIN,
    cashierPassword: FAKE_PASSWORD,
    timeoutMs: 400,
  });

const deps = (handle: DbHandle = admin): FiscalDeps => ({
  runInTransaction: async (fn) => await handle.db.transaction(async (tx) => await fn(tx)),
  provider: provider(),
});

const count = async (query: ReturnType<typeof sql>): Promise<number> =>
  (await admin.db.execute<{ n: number }>(query)).rows[0]?.n ?? -1;
const orderRow = async (orderId: string) =>
  (await admin.db.select().from(orders).where(eq(orders.id, orderId)))[0];
const docsOf = async (orderId: string) =>
  await admin.db.select().from(fiscalDocuments).where(eq(fiscalDocuments.orderId, orderId));

/** A card order paid through a verified WayForPay callback (the real pipeline, not a shortcut). */
async function paidCardOrder(variantId = variants[0] ?? ''): Promise<string> {
  const orderId = await placeOrder(admin, variantId, 'wayforpay');
  const attempt = await admin.db.transaction(
    async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'wayforpay' }),
  );
  await admin.db.transaction(async (tx) => {
    await recordAttemptResult(tx, {
      attemptId: attempt.attemptId,
      result: {
        ok: true,
        redirectUrl: 'https://secure.example/x',
        externalId: attempt.localReference,
      },
    });
  });
  const raw = wfpFake.callback({
    orderReference: attempt.localReference,
    amount: Number(attempt.amount) / 100,
    transactionStatus: 'Approved',
  });
  const handled = await handlePaymentWebhook(
    {
      provider: wfp,
      runInTransaction: async (fn) => await admin.db.transaction(async (tx) => await fn(tx)),
    },
    { rawBody: Buffer.from(raw), headers: new Headers(), sourceIp: null },
  );
  expect(handled.outcome.kind).toBe('applied');
  return orderId;
}

describe('card: the receipt is a job written by the payment, never a call from it', () => {
  it('a verified payment writes ONE pending document and ONE queue message in the same transaction', async () => {
    const orderId = await paidCardOrder();
    expect(await orderRow(orderId)).toMatchObject({
      paymentStatus: 'paid',
      fiscalStatus: 'pending',
    });
    const docs = await docsOf(orderId);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: 'sale', state: 'pending', provider: 'checkbox' });
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'fiscal.issue-receipt'`),
    ).toBe(1);
    // The provider was not called by the payment.
    expect(checkbox.receipts.size).toBe(0);
  });

  it('the job issues the receipt: fiscal number on the document and the order; a repeat is a no-op', async () => {
    const orderId = await paidCardOrder();
    const [doc] = await docsOf(orderId);
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('issued');
    expect((await docsOf(orderId))[0]).toMatchObject({ state: 'succeeded' });
    const order = await orderRow(orderId);
    expect(order).toMatchObject({ fiscalStatus: 'issued' });
    expect(order?.fiscalReceiptId).toBe(doc?.localReference);
    expect(order?.fiscalReceiptUrl).toBeTruthy();
    expect((await docsOf(orderId))[0]?.fiscalNumber).toMatch(/^FN/);
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('already_issued');
    expect(checkbox.receipts.size).toBe(1);
  });

  it('criterion: a 503 from the provider does not touch the payment; the retry makes ONE receipt', async () => {
    const orderId = await paidCardOrder();
    const [doc] = await docsOf(orderId);
    checkbox.failNextSell({ status: 503 });
    await expect(issueFiscalReceipt(deps(), doc?.id ?? '')).rejects.toBeInstanceOf(
      FiscalRetryError,
    );
    expect(await orderRow(orderId)).toMatchObject({
      paymentStatus: 'paid',
      fiscalStatus: 'pending',
    });
    expect((await docsOf(orderId))[0]).toMatchObject({ state: 'unknown', attempts: 1 });
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('issued');
    expect(checkbox.receipts.size).toBe(1);
  });

  it('a lost answer: the retry looks the receipt up first and adopts it, never a second one', async () => {
    const orderId = await paidCardOrder();
    const [doc] = await docsOf(orderId);
    checkbox.failNextSell({ status: 200, hang: true, store: true });
    await expect(issueFiscalReceipt(deps(), doc?.id ?? '')).rejects.toBeInstanceOf(
      FiscalRetryError,
    );
    expect(checkbox.receipts.size).toBe(1);
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('issued');
    expect(checkbox.receipts.size).toBe(1);
  });

  it('ADR-16: when the retries run out the document and the order say failed, ONE alert is queued, the money is untouched', async () => {
    const orderId = await paidCardOrder();
    const [doc] = await docsOf(orderId);
    for (let i = 0; i < MAX_FISCAL_ATTEMPTS; i += 1) {
      checkbox.failNextSell({ status: 503 });
      await expect(issueFiscalReceipt(deps(), doc?.id ?? '')).rejects.toBeInstanceOf(
        FiscalRetryError,
      );
    }
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('failed');
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('failed');
    expect(await orderRow(orderId)).toMatchObject({
      paymentStatus: 'paid',
      fiscalStatus: 'failed',
      capturedTotal: (await orderRow(orderId))?.total,
    });
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'alert.fiscal-failed'`),
    ).toBe(1);
  });

  it('a definite refusal (validation) fails at once with an alert', async () => {
    const orderId = await paidCardOrder();
    const [doc] = await docsOf(orderId);
    checkbox.failNextSell({ status: 422 });
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('failed');
    expect(await orderRow(orderId)).toMatchObject({
      fiscalStatus: 'failed',
      paymentStatus: 'paid',
    });
  });

  it('two workers on one document at once make one receipt', async () => {
    const orderId = await paidCardOrder();
    const [doc] = await docsOf(orderId);
    const results = await Promise.allSettled([
      issueFiscalReceipt(deps(world.connect()), doc?.id ?? ''),
      issueFiscalReceipt(deps(world.connect()), doc?.id ?? ''),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(checkbox.receipts.size).toBe(1);
  });
});

describe('cash on delivery and bank transfer', () => {
  it('COD: no receipt at confirmation; a receipt with the "Післяплата" form when shipped; a provider failure does not undo the shipment', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'cod');
    await admin.db.transaction(async (tx) => await confirmCodOrder(tx, { orderId, actor: 'm' }));
    expect(await docsOf(orderId)).toHaveLength(0);
    await admin.db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 'test' }));
    expect(await orderRow(orderId)).toMatchObject({ status: 'shipped', fiscalStatus: 'pending' });
    const [doc] = await docsOf(orderId);
    expect(doc).toMatchObject({ kind: 'sale', state: 'pending' });
    checkbox.failNextSell({ status: 503 });
    await expect(issueFiscalReceipt(deps(), doc?.id ?? '')).rejects.toBeInstanceOf(
      FiscalRetryError,
    );
    expect(await orderRow(orderId)).toMatchObject({ status: 'shipped' });
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('issued');
    expect(JSON.stringify(checkbox.receipts.get(doc?.localReference ?? '')?.body)).toContain(
      'Післяплата',
    );
  });

  it('bank transfer: not_required, no document, no queue message, no call', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'bank_transfer');
    const total = (await orderRow(orderId))?.total ?? 0;
    await admin.db.transaction(
      async (tx) =>
        await confirmTransferReceived(tx, {
          orderId,
          actor: 'm',
          bankReference: 'BANK-F1',
          receivedAmount: money(total),
        }),
    );
    expect(await orderRow(orderId)).toMatchObject({
      paymentStatus: 'paid',
      fiscalStatus: 'not_required',
    });
    expect(await docsOf(orderId)).toHaveLength(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'fiscal.issue-receipt'`),
    ).toBe(0);
    expect(checkbox.receipts.size).toBe(0);
    // Even when asked directly, a transfer order is never queued for a receipt.
    const direct = await admin.db.transaction(
      async (tx) => await enqueueSaleReceipt(tx, { orderId, paymentForm: 'card' }),
    );
    expect(direct).toBe('not_required');
    expect(await docsOf(orderId)).toHaveLength(0);
  });
});

/**
 * Runs two enqueue calls on separate connections so that the SECOND one starts while the FIRST
 * has written its document and not yet committed: the second's SELECT cannot see it, so only the
 * unique index with ON CONFLICT stands between it and a duplicate.
 */
async function racing<T>(
  call: (tx: Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0]) => Promise<T>,
): Promise<[T, T]> {
  const other = world.connect(3);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstWrote: () => void = () => undefined;
  const written = new Promise<void>((resolve) => {
    firstWrote = resolve;
  });
  const first = admin.db.transaction(async (tx) => {
    const result = await call(tx);
    firstWrote();
    await gate;
    return result;
  });
  await written;
  const second = other.db.transaction(async (tx) => await call(tx));
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  return await Promise.all([first, second]);
}

describe('Q35: the unique index is the guarantee, not the select before the insert', () => {
  it('two connections racing to write the sale document: one queued, one exists, never a throw', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'wayforpay');
    const results = await racing(
      async (tx) => await enqueueSaleReceipt(tx, { orderId, paymentForm: 'card' }),
    );
    expect(results).toEqual(['queued', 'exists']);
    expect(await docsOf(orderId)).toHaveLength(1);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'fiscal.issue-receipt'`),
    ).toBe(1);
  });

  it('two connections racing to write the return document of one refund: one queued, one exists', async () => {
    const orderId = await paidCardOrder();
    const [refund] = (
      await admin.db.execute<{ id: string }>(
        sql`INSERT INTO refund_operations (order_id, amount, state)
            VALUES (${orderId}, 5000, 'succeeded') RETURNING id`,
      )
    ).rows;
    const refundOperationId = refund?.id ?? '';
    const results = await racing(
      async (tx) =>
        await enqueueReturnReceipt(tx, { orderId, refundOperationId, amount: money(5000) }),
    );
    expect(results).toEqual(['queued', 'exists']);
    const returns = (await docsOf(orderId)).filter((doc) => doc.kind === 'return');
    expect(returns).toHaveLength(1);
  });
});

describe('refund: the return receipt points at the primary one', () => {
  async function refundAll(orderId: string, amount?: number): Promise<string> {
    const providers = { wayforpay: wfp };
    const attemptId = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT id FROM payment_attempts WHERE order_id = ${orderId} AND status = 'paid'`,
      )
    ).rows[0]?.id;
    const operationId = await admin.db.transaction(async (tx) => {
      if (amount === undefined) {
        const all = await requestFullRefund(tx, {
          orderId,
          reason: 'test',
          initiatedBy: null,
          providers,
        });
        return all[0]?.operationId ?? '';
      }
      const one = await requestRefund(tx, {
        orderId,
        attemptId: attemptId ?? '',
        amount: money(amount),
        reason: 'test',
        initiatedBy: null,
        providers,
      });
      return one.operationId;
    });
    await admin.db.transaction(async (tx) => await claimRefund(tx, operationId, ['wayforpay']));
    await admin.db.transaction(async (tx) => {
      await settleRefund(tx, {
        operationId,
        outcome: { state: 'succeeded', providerReference: null },
        confirmation: { by: null },
      });
    });
    return operationId;
  }

  it('a full refund makes a return document whose parent is the sale; it waits until the sale receipt exists', async () => {
    const orderId = await paidCardOrder();
    const [sale] = await docsOf(orderId);
    await refundAll(orderId);
    const docs = await docsOf(orderId);
    const ret = docs.find((d) => d.kind === 'return');
    expect(ret).toMatchObject({ parentDocumentId: sale?.id, state: 'pending' });
    // The primary receipt is not issued yet: the return waits (retryable), nothing is sent.
    await expect(issueFiscalReceipt(deps(), ret?.id ?? '')).rejects.toBeInstanceOf(
      FiscalRetryError,
    );
    expect(checkbox.receipts.size).toBe(0);
    await issueFiscalReceipt(deps(), sale?.id ?? '');
    expect(await issueFiscalReceipt(deps(), ret?.id ?? '')).toBe('issued');
    expect(checkbox.receipts.get(ret?.localReference ?? '')?.body).toMatchObject({
      related_receipt_id: sale?.localReference,
    });
    expect(await orderRow(orderId)).toMatchObject({ fiscalStatus: 'refund_issued' });
  });

  it('a partial refund is one line for the refunded amount; an order without a sale receipt gets none', async () => {
    const orderId = await paidCardOrder();
    const [sale] = await docsOf(orderId);
    await issueFiscalReceipt(deps(), sale?.id ?? '');
    await refundAll(orderId, 50000);
    const ret = (await docsOf(orderId)).find((d) => d.kind === 'return');
    expect(ret?.amount).toBe(50000);
    expect(JSON.stringify(ret?.itemsSnapshot)).toContain('"unitPrice":50000');
    expect(await issueFiscalReceipt(deps(), ret?.id ?? '')).toBe('issued');
  });
});

describe('review round: the receipt always adds up to what was paid', () => {
  it('a NEGATIVE adjustment (a compensation) is spread over the goods: the lines sum to the order total', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'wayforpay');
    await admin.db.execute(
      sql`UPDATE orders SET adjustment_total = -5001, total = total - 5001 WHERE id = ${orderId}`,
    );
    await admin.db.execute(
      sql`UPDATE orders SET payment_status = 'paid', paid_at = now() WHERE id = ${orderId}`,
    );
    expect(
      await admin.db.transaction(
        async (tx) => await enqueueSaleReceipt(tx, { orderId, paymentForm: 'card' }),
      ),
    ).toBe('queued');
    const [doc] = await docsOf(orderId);
    const order = await orderRow(orderId);
    const lines = (doc?.itemsSnapshot as { items: { unitPrice: number; quantity: number }[] })
      .items;
    expect(lines.reduce((total, l) => total + l.unitPrice * l.quantity, 0)).toBe(order?.total);
    expect(doc?.amount).toBe(order?.total);
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('issued');
  });

  it('lines that cannot add up never throw out of the payment: a failed document, the order says so, ONE alert', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'wayforpay');
    await admin.db.execute(
      sql`UPDATE order_items SET line_discount = line_discount + 100, line_total = line_total - 100 WHERE order_id = ${orderId}`,
    );
    await admin.db.execute(
      sql`UPDATE orders SET payment_status = 'paid', paid_at = now() WHERE id = ${orderId}`,
    );
    for (let i = 0; i < 2; i += 1) {
      await admin.db.transaction(async (tx) => {
        await enqueueSaleReceipt(tx, { orderId, paymentForm: 'card' });
      });
    }
    expect(await orderRow(orderId)).toMatchObject({
      paymentStatus: 'paid',
      fiscalStatus: 'failed',
    });
    expect((await docsOf(orderId))[0]).toMatchObject({ state: 'failed' });
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'alert.fiscal-failed'`),
    ).toBe(1);
  });

  it('a compensation that swallows the goods is the same failed document, not a thrown error', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'wayforpay');
    await admin.db.execute(
      sql`UPDATE orders SET shipping_total = 7000, adjustment_total = -subtotal, total = 7000 WHERE id = ${orderId}`,
    );
    await admin.db.execute(
      sql`UPDATE orders SET payment_status = 'paid', paid_at = now() WHERE id = ${orderId}`,
    );
    expect(
      await admin.db.transaction(
        async (tx) => await enqueueSaleReceipt(tx, { orderId, paymentForm: 'card' }),
      ),
    ).toBe('failed');
  });
});

describe('review round: the job under pressure', () => {
  it('the claim holds the order lock: a worker waits behind a held lock and then issues ONE receipt', async () => {
    const orderId = await paidCardOrder();
    const [doc] = await docsOf(orderId);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = world.connect().db.transaction(async (tx) => {
      await acquireLocks(tx, { orders: [orderId] });
      locked();
      await held;
    });
    await lockTaken;
    let done = false;
    const worker = issueFiscalReceipt(deps(world.connect()), doc?.id ?? '').then((outcome) => {
      done = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(done).toBe(false);
    expect(checkbox.receipts.size).toBe(0);
    release();
    await holder;
    expect(await worker).toBe('issued');
    expect(checkbox.receipts.size).toBe(1);
  });

  it('when the attempts run out the job looks once more: a receipt that exists is adopted, not failed', async () => {
    const orderId = await paidCardOrder();
    const [doc] = await docsOf(orderId);
    checkbox.failNextSell({ status: 200, hang: true, store: true });
    await expect(issueFiscalReceipt(deps(), doc?.id ?? '')).rejects.toBeInstanceOf(
      FiscalRetryError,
    );
    await admin.db.execute(
      sql`UPDATE fiscal_documents SET attempts = ${MAX_FISCAL_ATTEMPTS}, state = 'unknown' WHERE id = ${doc?.id ?? ''}`,
    );
    expect(await issueFiscalReceipt(deps(), doc?.id ?? '')).toBe('issued');
    expect(await orderRow(orderId)).toMatchObject({ fiscalStatus: 'issued' });
  });

  it('a return behind a FAILED sale fails at once with an alert instead of waiting for hours', async () => {
    const orderId = await paidCardOrder();
    const [sale] = await docsOf(orderId);
    checkbox.failNextSell({ status: 422 });
    expect(await issueFiscalReceipt(deps(), sale?.id ?? '')).toBe('failed');
    const attemptId = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT id FROM payment_attempts WHERE order_id = ${orderId} AND status = 'paid'`,
      )
    ).rows[0]?.id;
    const operationId = (
      await admin.db.execute<{ id: string }>(
        sql`INSERT INTO refund_operations (order_id, payment_attempt_id, amount, state) VALUES (${orderId}, ${attemptId}, 5000, 'succeeded') RETURNING id`,
      )
    ).rows[0]?.id;
    await admin.db.execute(
      sql`INSERT INTO fiscal_documents (order_id, kind, parent_document_id, refund_operation_id, provider, amount, items_snapshot)
          VALUES (${orderId}, 'return', ${sale?.id ?? ''}, ${operationId}, 'checkbox', 5000,
                  '{"paymentForm":"card","items":[{"code":"R","name":"Refund","unitPrice":5000,"quantity":1}]}'::jsonb)`,
    );
    const ret = (await docsOf(orderId)).find((d) => d.kind === 'return');
    expect(await issueFiscalReceipt(deps(), ret?.id ?? '')).toBe('failed');
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'alert.fiscal-failed'`),
    ).toBe(2);
  });

  it('a failed RETURN does not overwrite the status of a sale that WAS issued', async () => {
    const orderId = await paidCardOrder();
    const [sale] = await docsOf(orderId);
    await issueFiscalReceipt(deps(), sale?.id ?? '');
    expect(await orderRow(orderId)).toMatchObject({ fiscalStatus: 'issued' });
    const attemptId = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT id FROM payment_attempts WHERE order_id = ${orderId} AND status = 'paid'`,
      )
    ).rows[0]?.id;
    const operationId = (
      await admin.db.execute<{ id: string }>(
        sql`INSERT INTO refund_operations (order_id, payment_attempt_id, amount, state) VALUES (${orderId}, ${attemptId}, 5000, 'succeeded') RETURNING id`,
      )
    ).rows[0]?.id;
    await admin.db.execute(
      sql`INSERT INTO fiscal_documents (order_id, kind, parent_document_id, refund_operation_id, provider, amount, items_snapshot)
          VALUES (${orderId}, 'return', ${sale?.id ?? ''}, ${operationId}, 'checkbox', 5000,
                  '{"paymentForm":"card","items":[{"code":"R","name":"Refund","unitPrice":5000,"quantity":1}]}'::jsonb)`,
    );
    const ret = (await docsOf(orderId)).find((d) => d.kind === 'return');
    checkbox.failNextSell({ status: 422 });
    expect(await issueFiscalReceipt(deps(), ret?.id ?? '')).toBe('failed');
    const order = await orderRow(orderId);
    expect(order?.fiscalStatus).toBe('issued');
    expect(order?.fiscalError).toBeTruthy();
  });
});

describe('receipt lines: the discount is spread into unit prices and nothing is invented', () => {
  const item = (lineTotal: number, quantity: number) => ({
    nameSnapshot: 'Bra',
    colorName: 'Black',
    sizeLabel: '75B',
    skuSnapshot: 'SKU-1',
    quantity,
    lineTotal,
  });

  it('keeps the quantity when the total divides, folds it into one unit when it does not, and adds delivery', () => {
    const lines = buildReceiptLines({ shippingTotal: 7000, adjustmentTotal: 0 }, [
      item(40000, 2),
      item(10001, 3),
    ]);
    expect(lines[0]).toMatchObject({ unitPrice: 20000, quantity: 2 });
    expect(lines[1]).toMatchObject({ unitPrice: 10001, quantity: 1, name: 'Bra, Black, 75B x 3' });
    expect(lines[2]).toMatchObject({ code: 'DELIVERY', unitPrice: 7000 });
    expect(lineTotalOf(lines)).toBe(40000 + 10001 + 7000);
  });
});
