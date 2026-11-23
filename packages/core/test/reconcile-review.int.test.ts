/**
 * The review round of the payment flow, on real Postgres: reconciliation never settles from a
 * guess, never closes a live invoice, covers held (authorized) payments and walks past poison
 * attempts; the order is a card order in `pending` before a card attempt starts; a late transfer
 * is recorded; the expiry guard covers a call in flight; a provider's URL must be its own page.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { orders, paymentAttempts } from '@store/db/schema';
import { MonoProvider } from '@store/payments/mono';
import { startFakeMono, type FakeMono } from '@store/payments/test/fake-mono';
import type { PaymentProvider } from '@store/payments/types';
import { WayForPayProvider } from '@store/payments/wayforpay';
import {
  FAKE_ACCOUNT,
  FAKE_SECRET,
  startFakeWayForPay,
  type FakeWayForPay,
} from '@store/payments/test/fake-wayforpay';
import { money } from '@store/shared/money';

import {
  DomainError,
  AttemptUnresolvedError,
  OrderNotPayableError,
  PaymentMethodUnavailableError,
} from '../src/errors.ts';
import { releaseExpiredOrders } from '../src/orders/expiry.ts';
import { cancelOrder } from '../src/orders/fulfilment.ts';
import { handlePaymentWebhook, type WebhookDeps } from '../src/payments/handle-webhook.ts';
import { confirmCodOrder, confirmTransferReceived } from '../src/payments/offline.ts';
import { reconcileOpenAttempts } from '../src/payments/reconcile.ts';
import type { ProviderMap } from '../src/payments/refunds.ts';
import { createPaymentAttempt } from '../src/payments/attempts.ts';
import { startPayment, type StartPaymentDeps } from '../src/payments/start-payment.ts';
import { createWorld, type TestWorld } from './fixtures.ts';
import { placeOrder } from './place-order.ts';

let mono: FakeMono;
let wfp: FakeWayForPay;
let monoProvider: MonoProvider;
let wfpProvider: WayForPayProvider;
let world: TestWorld;
let admin: DbHandle;
let variants: string[];

beforeAll(async () => {
  mono = await startFakeMono();
  wfp = await startFakeWayForPay();
  monoProvider = new MonoProvider({
    baseUrl: mono.baseUrl,
    token: 't',
    timeoutMs: 400,
    pageHosts: ['pay.example'],
  });
  wfpProvider = new WayForPayProvider({
    baseUrl: wfp.baseUrl,
    merchantAccount: FAKE_ACCOUNT,
    secretKey: FAKE_SECRET,
    merchantDomainName: 'shop.example',
    timeoutMs: 400,
    pageHosts: ['secure.example'],
  });
});
afterAll(async () => {
  await mono.close();
  await wfp.close();
});
beforeEach(async () => {
  mono.reset();
  wfp.reset();
  world = await createWorld();
  admin = world.connect(2);
  variants = world.fixture.variantIds;
});
afterEach(async () => {
  await world.close();
});

const deps = (): StartPaymentDeps => ({
  runInTransaction: async (fn) => await admin.db.transaction(async (tx) => await fn(tx)),
  providers: { mono: monoProvider, wayforpay: wfpProvider },
  urls: {
    returnUrl: (n) => `https://shop.example/order/success?o=${n}`,
    webhookUrl: (p) => `https://shop.example/api/webhooks/${p}`,
  },
});
const run = async (
  batch?: number,
  providers: ProviderMap = { mono: monoProvider, wayforpay: wfpProvider },
) =>
  await reconcileOpenAttempts({
    db: admin.db,
    providers,
    ...(batch === undefined ? {} : { batch }),
  });

const count = async (query: ReturnType<typeof sql>): Promise<number> =>
  (await admin.db.execute<{ n: number }>(query)).rows[0]?.n ?? -1;
const orderRow = async (id: string) =>
  (await admin.db.select().from(orders).where(eq(orders.id, id)))[0];
const attemptsOf = async (orderId: string) =>
  await admin.db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));
const alerts = async (topic: string) =>
  await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = ${topic}`);

async function age(attemptId: string, minutes: number): Promise<void> {
  await admin.db.execute(
    sql`UPDATE payment_attempts
           SET created_at = now() - make_interval(mins => ${minutes}),
               expires_at = now() - make_interval(mins => ${minutes}) + interval '30 minutes'
         WHERE id = ${attemptId}`,
  );
}

/** A WayForPay order with a live invoice (the create call answered). */
async function liveWfp(
  variantId = variants[0] ?? '',
): Promise<{ orderId: string; attempt: typeof paymentAttempts.$inferSelect }> {
  const orderId = await placeOrder(admin, variantId, 'wayforpay');
  await startPayment(deps(), { orderId, provider: 'wayforpay' });
  const [attempt] = await attemptsOf(orderId);
  if (attempt === undefined) throw new Error('no attempt');
  return { orderId, attempt };
}

const uah = (kopiykas: number): number => kopiykas / 100;

async function deliverWfp(attemptRef: string, amount: number, transactionStatus: string) {
  const raw = wfp.callback({ orderReference: attemptRef, amount, transactionStatus });
  return await handlePaymentWebhook(
    {
      provider: wfpProvider,
      runInTransaction: async (fn) => await admin.db.transaction(async (tx) => await fn(tx)),
    },
    { rawBody: Buffer.from(raw), headers: new Headers(), sourceIp: null },
  );
}

describe('B1: a held (authorized) payment whose final webhook was lost is settled from the lookup', () => {
  it('asks about authorized attempts and credits the approved answer', async () => {
    const { orderId, attempt } = await liveWfp();
    await deliverWfp(attempt.localReference, uah(attempt.amount), 'WaitingAuthComplete');
    expect((await attemptsOf(orderId))[0]).toMatchObject({
      status: 'authorized',
      state: 'in_flight',
    });
    await age(attempt.id, 10);
    wfp.payments.set(attempt.localReference, {
      amount: uah(attempt.amount),
      status: 'Approved',
      reasonCode: 1100,
    });
    expect(await run()).toMatchObject({ checked: 1, applied: 1 });
    expect(await orderRow(orderId)).toMatchObject({
      paymentStatus: 'paid',
      capturedTotal: attempt.amount,
    });
  });

  it('a payment still held after six hours raises ONE alert', async () => {
    const { attempt } = await liveWfp();
    await deliverWfp(attempt.localReference, uah(attempt.amount), 'WaitingAuthComplete');
    await age(attempt.id, 7 * 60);
    wfp.payments.set(attempt.localReference, {
      amount: uah(attempt.amount),
      status: 'WaitingAuthComplete',
      reasonCode: 1100,
    });
    await run();
    await run();
    expect(await alerts('alert.attempt-unresolved')).toBe(1);
  });
});

describe('B2: "no such payment" never closes a live invoice', () => {
  it('an invoice with an id (in flight) stays open on a 404; the buyer is sent back to the SAME page', async () => {
    const { orderId, attempt } = await liveWfp();
    expect(attempt.externalId).toBe(attempt.localReference);
    await age(attempt.id, 10);
    // The fake knows no payment yet: CHECK_STATUS says "not found" although the page is payable.
    expect(await run()).toMatchObject({ checked: 1, closed: 0, providerErrors: 1 });
    expect((await attemptsOf(orderId))[0]).toMatchObject({ state: 'in_flight', status: 'pending' });
    // Not expired yet (age sets 20 minutes of validity left): the same page is reused.
    await admin.db.execute(
      sql`UPDATE payment_attempts SET expires_at = now() + interval '20 minutes' WHERE id = ${attempt.id}`,
    );
    const again = await startPayment(deps(), { orderId, provider: 'wayforpay' });
    expect(again).toMatchObject({ kind: 'redirect', reused: true });
    expect(await attemptsOf(orderId)).toHaveLength(1);
  });

  it('past its validity an unseen in-flight invoice is reported, not closed', async () => {
    const { orderId, attempt } = await liveWfp();
    await age(attempt.id, 120);
    expect(await run()).toMatchObject({ closed: 0, providerErrors: 1, alerts: 1 });
    expect((await attemptsOf(orderId))[0]).toMatchObject({ state: 'in_flight' });
  });

  it('only an attempt that never had an invoice, past validity plus margin, is closed', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'wayforpay');
    wfp.onCreate(() => ({ status: 200, hang: true }));
    await startPayment(deps(), { orderId, provider: 'wayforpay' });
    const [attempt] = await attemptsOf(orderId);
    expect(attempt).toMatchObject({ externalId: null, state: 'unknown' });
    await age(attempt?.id ?? '', 10);
    expect(await run()).toMatchObject({ closed: 0 });
    await age(attempt?.id ?? '', 90);
    expect(await run()).toMatchObject({ closed: 1 });
    expect((await attemptsOf(orderId))[0]).toMatchObject({ state: 'failed' });
  });
});

describe('S1: poison attempts do not starve the rest (a cursor)', () => {
  it('a batch smaller than the number of attempts that never settle still reaches the paid one', async () => {
    const poison: string[] = [];
    for (const variantId of [variants[0] ?? '', variants[1] ?? '']) {
      const { attempt } = await liveWfp(variantId);
      poison.push(attempt.id);
      await age(attempt.id, 100 - poison.length);
      // Approved for 1.00: contradicts the attempt, rejected every time.
      wfp.payments.set(attempt.localReference, { amount: 1, status: 'Approved', reasonCode: 1100 });
    }
    const good = await liveWfp(variants[0] ?? '');
    await age(good.attempt.id, 10);
    wfp.payments.set(good.attempt.localReference, {
      amount: uah(good.attempt.amount),
      status: 'Approved',
      reasonCode: 1100,
    });
    const result = await run(1);
    expect(result.checked).toBe(3);
    expect(await orderRow(good.orderId)).toMatchObject({ paymentStatus: 'paid' });
  });
});

describe('S2: reconciliation never settles from a guess', () => {
  const settle = async (status: string, reasonCode = 1100) => {
    const { orderId, attempt } = await liveWfp();
    await age(attempt.id, 10);
    wfp.payments.set(attempt.localReference, { amount: uah(attempt.amount), status, reasonCode });
    await run();
    return { orderId, attempt: (await attemptsOf(orderId))[0], order: await orderRow(orderId) };
  };

  it('Declined fails the attempt, the order is not paid', async () => {
    const { attempt, order } = await settle('Declined', 1101);
    expect(attempt).toMatchObject({ status: 'failed' });
    expect(order).toMatchObject({ paymentStatus: 'failed', capturedTotal: 0 });
  });

  it('Created, InProcessing and an unknown status leave it open and unpaid', async () => {
    for (const status of ['Created', 'InProcessing', 'SomethingNew']) {
      const { attempt, order } = await settle(status);
      expect(attempt, status).toMatchObject({ status: 'pending', state: 'in_flight' });
      expect(order, status).toMatchObject({ paymentStatus: 'pending', capturedTotal: 0 });
    }
  });

  it('Expired expires the attempt; Refunded on an unpaid attempt changes nothing', async () => {
    const expired = await settle('Expired');
    expect(expired.attempt).toMatchObject({ status: 'expired' });
    expect(expired.order?.capturedTotal).toBe(0);
    const refunded = await settle('Refunded');
    expect(refunded.order).toMatchObject({ paymentStatus: 'pending', capturedTotal: 0 });
  });

  it('an Approved answer that captured a different amount is rejected, never credited', async () => {
    const { orderId, attempt } = await liveWfp();
    await age(attempt.id, 10);
    const shortCapture: PaymentProvider = {
      code: 'wayforpay',
      statusLookupKey: 'localReference',
      isPaymentPage: () => true,
      createPayment: async (a) => await wfpProvider.createPayment(a),
      verifyWebhook: async (b) => await wfpProvider.verifyWebhook(b),
      refund: async (r) => await wfpProvider.refund(r),
      buildWebhookResponse: (r) => wfpProvider.buildWebhookResponse(r),
      getPaymentStatus: () =>
        Promise.resolve({
          externalId: attempt.localReference,
          localReference: attempt.localReference,
          currency: 'UAH',
          status: 'paid',
          amount: money(attempt.amount),
          capturedAmount: money(attempt.amount - 100),
          stateVersion: null,
          failureReason: null,
        }),
    };
    await run(undefined, { mono: monoProvider, wayforpay: shortCapture });
    expect(await orderRow(orderId)).toMatchObject({ paymentStatus: 'pending', capturedTotal: 0 });
    expect(await alerts('alert.payment-mismatch')).toBe(1);
  });
});

describe('S3: a rejected answer proves nothing and does not lift "unknown"', () => {
  it('an amount mismatch on an unknown attempt keeps it unknown, so no second invoice can open', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'wayforpay');
    wfp.onCreate(() => ({ status: 200, hang: true }));
    await startPayment(deps(), { orderId, provider: 'wayforpay' });
    const [attempt] = await attemptsOf(orderId);
    await age(attempt?.id ?? '', 10);
    wfp.payments.set(attempt?.localReference ?? '', {
      amount: 1,
      status: 'Approved',
      reasonCode: 1100,
    });
    await run();
    expect((await attemptsOf(orderId))[0]).toMatchObject({ state: 'unknown', externalId: null });
    wfp.reset();
    await admin.db.execute(
      sql`UPDATE payment_attempts SET created_at = now() - interval '5 minutes' WHERE id = ${attempt?.id ?? ''}`,
    );
    await expect(startPayment(deps(), { orderId, provider: 'wayforpay' })).rejects.toBeInstanceOf(
      AttemptUnresolvedError,
    );
  });
});

describe('S4: a card attempt needs a pending card order, under the lock', () => {
  it('a COD order the manager confirmed, and a transfer order, cannot be switched to a card', async () => {
    const cod = await placeOrder(admin, variants[0] ?? '', 'cod');
    await admin.db.transaction(
      async (tx) => await confirmCodOrder(tx, { orderId: cod, actor: 'm' }),
    );
    const calls = mono.requests.length;
    await expect(startPayment(deps(), { orderId: cod, provider: 'mono' })).rejects.toBeInstanceOf(
      OrderNotPayableError,
    );
    const transfer = await placeOrder(admin, variants[1] ?? '', 'bank_transfer');
    await expect(
      startPayment(deps(), { orderId: transfer, provider: 'mono' }),
    ).rejects.toBeInstanceOf(OrderNotPayableError);
    expect(mono.requests.length).toBe(calls);
    expect(await orderRow(cod)).toMatchObject({ paymentProvider: 'cod', status: 'confirmed' });
    expect(await orderRow(transfer)).toMatchObject({ paymentProvider: 'bank_transfer' });
    expect(await count(sql`SELECT count(*)::int AS n FROM payment_attempts`)).toBe(0);
  });

  it('a card order that left pending (confirmed by hand) refuses a new attempt', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'mono');
    await admin.db.execute(sql`UPDATE orders SET status = 'confirmed' WHERE id = ${orderId}`);
    await expect(
      admin.db.transaction(
        async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
      ),
    ).rejects.toBeInstanceOf(OrderNotPayableError);
  });
});

describe('S5: a transfer received for a cancelled order is recorded with an alert', () => {
  it('keeps the money as a fact, writes a late-payment alert, changes no status and ships nothing', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'bank_transfer');
    const total = (await orderRow(orderId))?.total ?? 0;
    await admin.db.transaction(
      async (tx) => await cancelOrder(tx, { orderId, source: 'test', reason: null }),
    );
    await admin.db.transaction(
      async (tx) =>
        await confirmTransferReceived(tx, {
          orderId,
          actor: 'm',
          bankReference: 'BANK-LATE-2',
          receivedAmount: money(total),
        }),
    );
    expect(await orderRow(orderId)).toMatchObject({
      status: 'cancelled',
      paymentStatus: 'paid',
      capturedTotal: total,
    });
    expect(await alerts('alert.late-payment')).toBe(1);
    expect(await alerts('email.payment-received')).toBe(0);
  });

  it('the same bank line on two orders at once: one wins, the other gets the typed refusal', async () => {
    const a = await placeOrder(admin, variants[0] ?? '', 'bank_transfer');
    const b = await placeOrder(admin, variants[1] ?? '', 'bank_transfer');
    const totalA = (await orderRow(a))?.total ?? 0;
    const totalB = (await orderRow(b))?.total ?? 0;
    const confirm = async (orderId: string, total: number) => {
      const handle = world.connect();
      return await handle.db.transaction(
        async (tx) =>
          await confirmTransferReceived(tx, {
            orderId,
            actor: 'm',
            bankReference: 'BANK-SAME',
            receivedAmount: money(total),
          }),
      );
    };
    const results = await Promise.allSettled([confirm(a, totalA), confirm(b, totalB)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(DomainError);
  });
});

describe('S6: the expiry guard covers a provider call still in flight', () => {
  it('an order whose attempt is pending is not cancelled, even with an expired reservation', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'mono');
    await admin.db.transaction(
      async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
    );
    await admin.db.execute(
      sql`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${orderId}`,
    );
    expect((await releaseExpiredOrders(admin.db)).expired).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: 'pending' });
    // And the cancel itself (the expiry path) refuses, under the order lock.
    const direct = await admin.db.transaction(
      async (tx) =>
        await cancelOrder(tx, {
          orderId,
          source: 'worker:expiry',
          reason: null,
          expiredOnly: true,
        }),
    );
    expect(direct.changed).toBe(false);
  });
});

describe("W4 and the provider name: only the provider's own page, only own providers", () => {
  it('a provider URL that is not its own page is a lost answer: nothing stored, nothing redirected', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'wayforpay');
    wfp.onCreate(() => ({
      status: 200,
      json: { reasonCode: 1100, invoiceUrl: 'javascript:alert(document.cookie)' },
    }));
    const result = await startPayment(deps(), { orderId, provider: 'wayforpay' });
    expect(result.kind).toBe('unresolved');
    expect((await attemptsOf(orderId))[0]?.redirectUrl).toBeNull();
    const orderMono = await placeOrder(admin, variants[1] ?? '', 'mono');
    mono.onCreate(() => ({
      status: 200,
      json: { invoiceId: 'inv-evil', pageUrl: 'https://evil.example/pay' },
    }));
    expect((await startPayment(deps(), { orderId: orderMono, provider: 'mono' })).kind).toBe(
      'unresolved',
    );
    expect((await attemptsOf(orderMono))[0]?.redirectUrl).toBeNull();
  });

  it('a stored URL that is no longer a provider page is never replayed to a buyer', async () => {
    const { orderId, attempt } = await liveWfp();
    await admin.db.execute(
      sql`UPDATE payment_attempts SET redirect_url = 'http://evil.example/x' WHERE id = ${attempt.id}`,
    );
    await expect(startPayment(deps(), { orderId, provider: 'wayforpay' })).rejects.toThrow();
    // (the live-invoice rule refuses a second attempt; nothing was redirected)
  });

  it('prototype names are not providers', async () => {
    const orderId = await placeOrder(admin, variants[0] ?? '', 'mono');
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      await expect(
        // @ts-expect-error: a name from outside is deliberately not a ProviderCode here
        startPayment(deps(), { orderId, provider: name }),
      ).rejects.toBeInstanceOf(PaymentMethodUnavailableError);
    }
  });
});

describe('W2 (core part): storing refused bodies can be switched off without touching genuine ones', () => {
  it('a refused message is answered 400 and not stored; the genuine one still applies', async () => {
    const { orderId, attempt } = await liveWfp();
    const handle = (mayStore: boolean): WebhookDeps => ({
      provider: wfpProvider,
      mayStoreUnverified: () => mayStore,
      runInTransaction: async (fn) => await admin.db.transaction(async (tx) => await fn(tx)),
    });
    const bad = wfp.callback({
      orderReference: attempt.localReference,
      amount: uah(attempt.amount),
      transactionStatus: 'Approved',
      secret: 'wrong',
    });
    const refused = await handlePaymentWebhook(handle(false), {
      rawBody: Buffer.from(bad),
      headers: new Headers(),
      sourceIp: null,
    });
    expect(refused.response.status).toBe(400);
    expect(await count(sql`SELECT count(*)::int AS n FROM webhook_quarantine`)).toBe(0);
    const genuine = wfp.callback({
      orderReference: attempt.localReference,
      amount: uah(attempt.amount),
      transactionStatus: 'Approved',
    });
    const applied = await handlePaymentWebhook(handle(false), {
      rawBody: Buffer.from(genuine),
      headers: new Headers(),
      sourceIp: null,
    });
    expect(applied.outcome.kind).toBe('applied');
    expect(await orderRow(orderId)).toMatchObject({ paymentStatus: 'paid' });
  });
});
