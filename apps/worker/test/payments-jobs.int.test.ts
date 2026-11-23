/**
 * Phase 3 worker pieces on real Postgres: the payment and refund emails, the fiscal receipt job
 * routed through the message sender, `payments.reconcile-open`, the quarantine cleanup and the
 * fiscal gap report. Providers are the real adapters against local fakes.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setCartItem, startCheckout } from '@store/core/cart';
import { enqueueSaleReceipt } from '@store/core/fiscal-receipts';
import { createOrder } from '@store/core/orders';
import { quoteCheckout } from '@store/core/quote';
import { createDb, type DbHandle } from '@store/db/client';
import { settings } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import { CheckboxProvider } from '@store/payments/checkbox';
import {
  FAKE_LICENSE,
  FAKE_LOGIN,
  FAKE_PASSWORD,
  startFakeCheckbox,
  type FakeCheckbox,
} from '@store/payments/test/fake-checkbox';
import {
  FAKE_ACCOUNT,
  FAKE_SECRET,
  startFakeWayForPay,
  type FakeWayForPay,
} from '@store/payments/test/fake-wayforpay';
import { WayForPayProvider } from '@store/payments/wayforpay';

import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { createJobHandlers, JOB_NAMES } from '../src/jobs.ts';
import { createMessageSender, FiscalNotConfiguredError } from '../src/router.ts';

let testDb: TestDatabase;
let app: DbHandle;
let variantId = '';
let checkbox: FakeCheckbox;
let wfpFake: FakeWayForPay;
let wfp: WayForPayProvider;

beforeAll(async () => {
  checkbox = await startFakeCheckbox();
  wfpFake = await startFakeWayForPay();
  wfp = new WayForPayProvider({
    baseUrl: wfpFake.baseUrl,
    merchantAccount: FAKE_ACCOUNT,
    secretKey: FAKE_SECRET,
    merchantDomainName: 'shop.example',
    timeoutMs: 400,
  });
});
afterAll(async () => {
  await checkbox.close();
  await wfpFake.close();
});
beforeEach(async () => {
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 3 });
  const fixture = await app.db.transaction(async (tx) => {
    await tx.insert(settings).values({
      key: 'payment_providers',
      value: { cod: true, bank_transfer: true, wayforpay: true, mono: true },
    });
    return await seedMoneySkeleton(tx);
  });
  variantId = fixture.variantIds[0];
  await app.db.execute(sql`UPDATE product_variants SET stock_quantity = 50`);
  checkbox.receipts.clear();
  checkbox.state.shiftOpen = false;
});
afterEach(async () => {
  await app.close();
  await testDb.drop();
});

let seq = 0;
async function placeOrder(provider: 'cod' | 'wayforpay' = 'cod', locale: 'uk' | 'en' = 'uk') {
  seq += 1;
  const token = `tok-pj-${String(seq)}`.padEnd(20, 'x');
  await app.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId, quantity: 1 });
  });
  const intent = await app.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  await app.db.transaction(async (tx) => {
    await quoteCheckout(tx, {
      cartToken: token,
      intentId: intent.intentId,
      delivery: 'pickup',
      promoCode: null,
    });
  });
  return await app.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: intent.intentId,
        ownerToken: token,
        contact: { email: 'buyer@example.com', phone: '+380501234567', name: 'Іра' },
        delivery: { method: 'pickup' },
        paymentProvider: provider,
        promoCode: null,
        locale,
        termsAccepted: true,
      }),
  );
}

class Recorder implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

const senderFor = (email: Recorder, withFiscal: boolean) =>
  createMessageSender({
    reader: app.db,
    email,
    siteUrl: 'https://shop.example',
    fiscal: withFiscal
      ? {
          runInTransaction: async (fn) => await app.db.transaction(async (tx) => await fn(tx)),
          provider: new CheckboxProvider({
            baseUrl: checkbox.baseUrl,
            licenseKey: FAKE_LICENSE,
            cashierLogin: FAKE_LOGIN,
            cashierPassword: FAKE_PASSWORD,
            timeoutMs: 400,
          }),
        }
      : null,
    log: () => undefined,
  });

describe('payment and refund emails', () => {
  it('payment received: one mail to the buyer, the amount from the database, an idempotency key', async () => {
    const placed = await placeOrder('cod', 'en');
    const email = new Recorder();
    await senderFor(email, false).send({
      idempotencyKey: `payment-received:${placed.orderId}`,
      topic: 'email.payment-received',
      payload: { orderId: placed.orderId },
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({
      to: 'buyer@example.com',
      idempotencyKey: `payment-received:${placed.orderId}:customer`,
    });
    expect(email.sent[0]?.subject).toContain(`Payment for order ${placed.orderNumber} received`);
    expect(email.sent[0]?.html).toContain('prefers-color-scheme: dark');
  });

  it('payment failed: the buyer is told to try again; a cancelled order gets nothing', async () => {
    const placed = await placeOrder('cod');
    const email = new Recorder();
    const sender = senderFor(email, false);
    await sender.send({
      idempotencyKey: 'payment-failed:a1',
      topic: 'email.payment-failed',
      payload: { orderId: placed.orderId },
    });
    expect(email.sent[0]?.subject).toContain('не пройшла');
    await app.db.execute(sql`UPDATE orders SET status = 'cancelled' WHERE id = ${placed.orderId}`);
    await sender.send({
      idempotencyKey: 'payment-failed:a2',
      topic: 'email.payment-failed',
      payload: { orderId: placed.orderId },
    });
    expect(email.sent).toHaveLength(1);
  });

  it('refund: the amount comes from refund_operations; partial and full read differently; a foreign operation is refused', async () => {
    const placed = await placeOrder('cod', 'en');
    const [order] = (
      await app.db.execute<{ total: number }>(
        sql`SELECT total FROM orders WHERE id = ${placed.orderId}`,
      )
    ).rows;
    const total = order?.total ?? 0;
    const insertOperation = async (amount: number): Promise<string> =>
      (
        await app.db.execute<{ id: string }>(
          sql`INSERT INTO refund_operations (order_id, amount, state) VALUES (${placed.orderId}, ${amount}, 'succeeded') RETURNING id`,
        )
      ).rows[0]?.id ?? '';
    const partial = await insertOperation(1000);
    const full = await insertOperation(total);
    const email = new Recorder();
    const sender = senderFor(email, false);
    await sender.send({
      idempotencyKey: `refund:${partial}`,
      topic: 'email.refund-issued',
      payload: { orderId: placed.orderId, operationId: partial },
    });
    await sender.send({
      idempotencyKey: `refund:${full}`,
      topic: 'email.refund-issued',
      payload: { orderId: placed.orderId, operationId: full },
    });
    expect(email.sent[0]?.text).toContain('part of the amount you paid');
    expect(email.sent[1]?.text).toContain('the full amount you paid');
    const other = await placeOrder('cod');
    await expect(
      sender.send({
        idempotencyKey: 'x',
        topic: 'email.refund-issued',
        payload: { orderId: other.orderId, operationId: partial },
      }),
    ).rejects.toThrow('refund operation not found');
  });
});

describe('fiscal.issue-receipt through the router', () => {
  it('issues the receipt with the provider; without a provider it fails visibly and the document stays pending', async () => {
    const placed = await placeOrder('cod');
    await app.db.execute(
      sql`UPDATE orders SET payment_status = 'paid', paid_at = now() WHERE id = ${placed.orderId}`,
    );
    await app.db.transaction(async (tx) => {
      await enqueueSaleReceipt(tx, { orderId: placed.orderId, paymentForm: 'card' });
    });
    const documentId = (
      await app.db.execute<{ id: string }>(
        sql`SELECT id FROM fiscal_documents WHERE order_id = ${placed.orderId}`,
      )
    ).rows[0]?.id;
    const message = {
      idempotencyKey: 'fiscal:x',
      topic: 'fiscal.issue-receipt',
      payload: { documentId },
    };
    await expect(senderFor(new Recorder(), false).send(message)).rejects.toBeInstanceOf(
      FiscalNotConfiguredError,
    );
    expect(checkbox.receipts.size).toBe(0);
    await senderFor(new Recorder(), true).send(message);
    expect(checkbox.receipts.size).toBe(1);
    const [row] = (
      await app.db.execute<{ fiscal_status: string }>(
        sql`SELECT fiscal_status FROM orders WHERE id = ${placed.orderId}`,
      )
    ).rows;
    expect(row?.fiscal_status).toBe('issued');
  });
});

describe('the scheduled payment jobs', () => {
  const handlers = (logs: string[]) =>
    createJobHandlers({
      db: app.db,
      directory: null,
      providers: { wayforpay: wfp },
      log: (line) => logs.push(line),
    });

  it('payments.reconcile-open asks the provider and logs counts only', async () => {
    const placed = await placeOrder('wayforpay');
    const ref = (
      await app.db.execute<{ local_reference: string }>(
        sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state)
              SELECT id, 1, 'wayforpay', total, 'unknown' FROM orders WHERE id = ${placed.orderId}
            RETURNING local_reference`,
      )
    ).rows[0]?.local_reference;
    await app.db.execute(
      sql`UPDATE payment_attempts SET created_at = now() - interval '10 minutes'`,
    );
    const logs: string[] = [];
    // The provider has no such payment: the attempt is closed.
    wfpFake.payments.delete(ref ?? '');
    await handlers(logs)[JOB_NAMES.reconcileOpen]();
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      scope: JOB_NAMES.reconcileOpen,
      checked: 1,
      closed: 1,
    });
    expect(logs[0]).not.toContain('buyer@example.com');
    expect(logs[0]).not.toContain(ref ?? 'no-ref');
  });

  it('quarantine.cleanup removes old rows and keeps recent ones', async () => {
    await app.db.execute(
      sql`INSERT INTO webhook_quarantine (provider, raw_body, reason, created_at)
          VALUES ('mono', 'old', 'x', now() - interval '30 days'), ('mono', 'new', 'x', now())`,
    );
    const logs: string[] = [];
    await handlers(logs)[JOB_NAMES.cleanQuarantine]();
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ removed: 1 });
    const left = await app.db.execute<{ raw_body: string }>(
      sql`SELECT raw_body FROM webhook_quarantine`,
    );
    expect(left.rows.map((r) => r.raw_body)).toEqual(['new']);
  });

  it('fiscal.reconcile fails the job when a paid order has no receipt after the grace period', async () => {
    const placed = await placeOrder('cod');
    const logs: string[] = [];
    await handlers(logs)[JOB_NAMES.reconcileFiscal]();
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ missing: 0 });
    await app.db.execute(
      sql`UPDATE orders SET payment_status = 'paid', fiscal_status = 'pending', paid_at = now() - interval '3 hours' WHERE id = ${placed.orderId}`,
    );
    await expect(handlers(logs)[JOB_NAMES.reconcileFiscal]()).rejects.toThrow('no fiscal receipt');
    expect(JSON.parse(logs[1] ?? '{}')).toMatchObject({
      level: 'error',
      missing: 1,
      orders: [placed.orderId],
    });
  });
});
