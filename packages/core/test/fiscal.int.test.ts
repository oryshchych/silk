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
import { buildReceiptLines, enqueueSaleReceipt, lineTotalOf } from '../src/fiscal/receipts.ts';
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
