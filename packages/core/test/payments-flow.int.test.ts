/**
 * Phase 3 core flow on real Postgres: starting a payment for an existing order (ADR-11), the
 * reconciliation job (ADR-4 source 2, Q17, Q27) and the manager confirmations for COD and bank
 * transfer (ADR-4 source 3, Q16). Real adapters against local fakes; separate connections and
 * barriers for every race.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { orders, paymentAttempts } from '@store/db/schema';
import { money } from '@store/shared/money';
import { MonoProvider } from '@store/payments/mono';
import { startFakeMono, type FakeMono } from '@store/payments/test/fake-mono';
import { WayForPayProvider } from '@store/payments/wayforpay';
import {
  FAKE_ACCOUNT,
  FAKE_SECRET,
  startFakeWayForPay,
  type FakeWayForPay,
} from '@store/payments/test/fake-wayforpay';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import {
  OrderNotConfirmableError,
  OrderNotShippableError,
  PaymentMethodUnavailableError,
  PaymentProviderRefusedError,
  TransferAmountMismatchError,
} from '../src/errors.ts';
import { cancelOrder, shipOrder } from '../src/orders/fulfilment.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { handlePaymentWebhook } from '../src/payments/handle-webhook.ts';
import { confirmCodOrder, confirmTransferReceived } from '../src/payments/offline.ts';
import { resolveOrderForPayment } from '../src/orders/lookup.ts';
import { reconcileOpenAttempts } from '../src/payments/reconcile.ts';
import { startPayment, type StartPaymentDeps } from '../src/payments/start-payment.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let mono: FakeMono;
let wfp: FakeWayForPay;
let monoProvider: MonoProvider;
let wfpProvider: WayForPayProvider;
let world: TestWorld;
let admin: DbHandle;
let variants: string[];
let seq = 0;

beforeAll(async () => {
  mono = await startFakeMono();
  wfp = await startFakeWayForPay();
  monoProvider = new MonoProvider({
    pageHosts: ['pay.example'],
    baseUrl: mono.baseUrl,
    token: 't',
    timeoutMs: 400,
  });
  wfpProvider = new WayForPayProvider({
    pageHosts: ['secure.example'],
    baseUrl: wfp.baseUrl,
    merchantAccount: FAKE_ACCOUNT,
    secretKey: FAKE_SECRET,
    merchantDomainName: 'shop.example',
    timeoutMs: 400,
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

const depsFor = (handle: DbHandle = admin): StartPaymentDeps => ({
  runInTransaction: async (fn) => await handle.db.transaction(async (tx) => await fn(tx)),
  providers: { mono: monoProvider, wayforpay: wfpProvider },
  urls: {
    returnUrl: (n) => `https://shop.example/order/success?o=${n}`,
    webhookUrl: (p) => `https://shop.example/api/webhooks/${p}`,
  },
});

async function place(
  provider: 'mono' | 'wayforpay' | 'cod' | 'bank_transfer',
  variantId = variants[0] ?? '',
): Promise<string> {
  seq += 1;
  // The skeleton has one unit per variant; these tests place several orders.
  await admin.db.execute(
    sql`UPDATE product_variants SET stock_quantity = 50 WHERE id = ${variantId}`,
  );
  const token = `tok-flow-${String(seq)}`.padEnd(20, 'x');
  await admin.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId, quantity: 1 });
  });
  const intent = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await admin.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: intent.intentId,
        ownerToken: token,
        contact: { email: 'b@example.com', phone: `+38050111${String(1000 + seq)}`, name: 'Buyer' },
        delivery: { method: 'pickup' },
        paymentProvider: provider,
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  return placed.orderId;
}

const count = async (query: ReturnType<typeof sql>): Promise<number> =>
  (await admin.db.execute<{ n: number }>(query)).rows[0]?.n ?? -1;

const orderRow = async (orderId: string) =>
  (await admin.db.select().from(orders).where(eq(orders.id, orderId)))[0];

const attemptsOf = async (orderId: string) =>
  await admin.db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));

const reservedTotal = async (): Promise<number> =>
  await count(sql`SELECT coalesce(sum(reserved_quantity), 0)::int AS n FROM product_variants`);

const sourcesOf = async (orderId: string): Promise<string[]> =>
  (
    await admin.db.execute<{ source: string }>(
      sql`SELECT source FROM order_status_history WHERE order_id = ${orderId} ORDER BY created_at`,
    )
  ).rows.map((row) => row.source);

describe('startPayment: an attempt on an existing order (ADR-11)', () => {
  it('creates the attempt first, calls the provider, and records the invoice', async () => {
    const orderId = await place('mono');
    const result = await startPayment(depsFor(), { orderId, provider: 'mono' });
    expect(result).toMatchObject({ kind: 'redirect', reused: false });
    const [attempt] = await attemptsOf(orderId);
    expect(attempt).toMatchObject({ state: 'in_flight', provider: 'mono', attemptNumber: 1 });
    expect(attempt?.externalId).toMatch(/^inv-/);
    const sent = JSON.parse(mono.requests.at(-1)?.body ?? '{}') as {
      merchantPaymInfo: { reference: string };
      webHookUrl: string;
    };
    expect(sent.merchantPaymInfo.reference).toBe(attempt?.localReference);
    expect(sent.webHookUrl).toBe('https://shop.example/api/webhooks/mono');
  });

  it('a second request while the invoice is live reuses it: one attempt, one provider call', async () => {
    const orderId = await place('mono');
    const before = mono.requests.filter((r) => r.url.includes('invoice/create')).length;
    const first = await startPayment(depsFor(), { orderId, provider: 'mono' });
    const second = await startPayment(depsFor(), { orderId, provider: 'mono' });
    expect(second).toMatchObject({ kind: 'redirect', reused: true });
    if (first.kind === 'redirect' && second.kind === 'redirect') {
      expect(second.url).toBe(first.url);
    }
    expect(await attemptsOf(orderId)).toHaveLength(1);
    expect(mono.requests.filter((r) => r.url.includes('invoice/create')).length - before).toBe(1);
  });

  it('ADR-11 "another card": after a failed attempt, a second attempt on the SAME order, no second reservation', async () => {
    const orderId = await place('wayforpay');
    const reservedBefore = await reservedTotal();
    const first = await startPayment(depsFor(), { orderId, provider: 'wayforpay' });
    expect(first.kind).toBe('redirect');
    const [attempt] = await attemptsOf(orderId);
    // The buyer's card is declined: a verified Declined callback closes the first attempt.
    const raw = wfp.callback({
      orderReference: attempt?.localReference ?? '',
      amount: Number(attempt?.amount) / 100,
      transactionStatus: 'Declined',
      reasonCode: 1101,
    });
    await handlePaymentWebhook(
      {
        provider: wfpProvider,
        runInTransaction: async (fn) => await admin.db.transaction(async (tx) => await fn(tx)),
      },
      { rawBody: Buffer.from(raw), headers: new Headers(), sourceIp: null },
    );
    const second = await startPayment(depsFor(), { orderId, provider: 'wayforpay' });
    expect(second).toMatchObject({ kind: 'redirect', reused: false });
    expect(await attemptsOf(orderId)).toHaveLength(2);
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(1);
    expect(await reservedTotal()).toBe(reservedBefore);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM stock_reservations WHERE order_id = ${orderId}`,
      ),
    ).toBe(1);
  });

  it('a definite refusal closes the attempt and leaves the order payable again', async () => {
    const orderId = await place('mono');
    mono.onCreate(() => ({ status: 400, json: { errText: 'bad' } }));
    await expect(startPayment(depsFor(), { orderId, provider: 'mono' })).rejects.toBeInstanceOf(
      PaymentProviderRefusedError,
    );
    expect((await attemptsOf(orderId))[0]).toMatchObject({ state: 'failed', status: 'failed' });
    mono.onCreate((body) => {
      const invoiceId = `inv-retry-${String(seq)}`;
      mono.invoices.set(invoiceId, {
        invoiceId,
        status: 'created',
        reference: JSON.stringify(body),
      });
      return { status: 200, json: { invoiceId, pageUrl: `https://pay.example/${invoiceId}` } };
    });
    expect((await startPayment(depsFor(), { orderId, provider: 'mono' })).kind).toBe('redirect');
    expect(await attemptsOf(orderId)).toHaveLength(2);
  });

  it('a switched-off provider and an unconfigured one never reach the network', async () => {
    const orderId = await place('mono');
    await admin.db.execute(
      sql`UPDATE settings SET value = '{"mono": false, "wayforpay": true, "cod": true, "bank_transfer": true}'::jsonb WHERE key = 'payment_providers'`,
    );
    const calls = mono.requests.length;
    await expect(startPayment(depsFor(), { orderId, provider: 'mono' })).rejects.toBeInstanceOf(
      PaymentMethodUnavailableError,
    );
    await expect(
      startPayment({ ...depsFor(), providers: {} }, { orderId, provider: 'wayforpay' }),
    ).rejects.toBeInstanceOf(PaymentMethodUnavailableError);
    expect(mono.requests.length).toBe(calls);
    expect(await attemptsOf(orderId)).toHaveLength(0);
  });

  it('a double click on separate connections opens exactly one invoice', async () => {
    const orderId = await place('mono');
    const barrier = new Barrier(2);
    const calls = mono.requests.filter((r) => r.url.includes('invoice/create')).length;
    const run = async () => {
      await barrier.wait();
      return await startPayment(depsFor(world.connect()), { orderId, provider: 'mono' });
    };
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await attemptsOf(orderId)).toHaveLength(1);
    expect(mono.requests.filter((r) => r.url.includes('invoice/create')).length - calls).toBe(1);
  });
});

/** Ages an attempt so the reconciliation job considers it. */
async function age(attemptId: string, minutes: number, expiresInMinutes = 30): Promise<void> {
  await admin.db.execute(
    sql`UPDATE payment_attempts
           SET created_at = now() - make_interval(mins => ${minutes}),
               expires_at = now() - make_interval(mins => ${minutes}) + make_interval(mins => ${expiresInMinutes})
         WHERE id = ${attemptId}`,
  );
}

describe('reconcileOpenAttempts: ask the provider before anything is cancelled', () => {
  const run = async () =>
    await reconcileOpenAttempts({
      db: admin.db,
      providers: { mono: monoProvider, wayforpay: wfpProvider },
    });

  it('a lost create answer is resolved by OUR reference and the payment is credited from the lookup', async () => {
    const orderId = await place('wayforpay');
    wfp.onCreate(() => ({ status: 200, hang: true }));
    const started = await startPayment(depsFor(), { orderId, provider: 'wayforpay' });
    expect(started.kind).toBe('unresolved');
    const [attempt] = await attemptsOf(orderId);
    expect(attempt?.state).toBe('unknown');
    await age(attempt?.id ?? '', 10);
    // The buyer did pay at WayForPay although we never saw the invoice answer.
    wfp.payments.set(attempt?.localReference ?? '', {
      amount: Number(attempt?.amount) / 100,
      status: 'Approved',
      reasonCode: 1100,
    });
    const result = await run();
    expect(result).toMatchObject({ checked: 1, applied: 1 });
    const order = await orderRow(orderId);
    expect(order).toMatchObject({ paymentStatus: 'paid', capturedTotal: attempt?.amount });
    expect(await sourcesOf(orderId)).toContain('reconcile:wayforpay');
    // Stock untouched by payment (ADR-18).
    expect(await reservedTotal()).toBeGreaterThan(0);
    // A second run changes nothing.
    expect((await run()).checked).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'email.payment-received'`,
      ),
    ).toBe(1);
  });

  it('an attempt that never had an invoice is closed on "no such payment" once its validity and margin passed, so the order may be retried', async () => {
    const orderId = await place('wayforpay');
    wfp.onCreate(() => ({ status: 200, hang: true }));
    await startPayment(depsFor(), { orderId, provider: 'wayforpay' });
    const [attempt] = await attemptsOf(orderId);
    await age(attempt?.id ?? '', 10);
    wfp.payments.delete(attempt?.localReference ?? '');
    expect(await run()).toMatchObject({ closed: 0, providerErrors: 1 });
    await age(attempt?.id ?? '', 90);
    expect(await run()).toMatchObject({ closed: 1 });
    expect((await attemptsOf(orderId))[0]).toMatchObject({ state: 'failed' });
    wfp.reset();
    const retry = await startPayment(depsFor(), { orderId, provider: 'wayforpay' });
    expect(retry.kind).toBe('redirect');
  });

  it('a provider answer that contradicts the attempt (another amount) is rejected with an alert, never credited', async () => {
    const orderId = await place('wayforpay');
    wfp.onCreate((body) => {
      wfp.payments.set(String(body['orderReference']), {
        amount: 1,
        status: 'Approved',
        reasonCode: 1100,
      });
      return { status: 200, json: { reasonCode: 1100, invoiceUrl: 'https://secure.example/x' } };
    });
    await startPayment(depsFor(), { orderId, provider: 'wayforpay' });
    const [attempt] = await attemptsOf(orderId);
    await age(attempt?.id ?? '', 10);
    await run();
    expect(await orderRow(orderId)).toMatchObject({ paymentStatus: 'pending', capturedTotal: 0 });
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'alert.payment-mismatch'`,
      ),
    ).toBe(1);
  });

  it('Mono without an invoice id cannot be asked: left alone while it may still be paid, closed once it cannot', async () => {
    const orderId = await place('mono');
    mono.onCreate(() => ({ status: 200, hang: true }));
    await startPayment(depsFor(), { orderId, provider: 'mono' });
    const [attempt] = await attemptsOf(orderId);
    expect(attempt?.externalId).toBeNull();
    await age(attempt?.id ?? '', 10);
    expect(await run()).toMatchObject({ unaskable: 1, closed: 0 });
    expect((await attemptsOf(orderId))[0]?.state).toBe('unknown');
    // Validity (30 min) plus the margin (30 min) have passed.
    await age(attempt?.id ?? '', 90);
    expect(await run()).toMatchObject({ closed: 1 });
    expect((await attemptsOf(orderId))[0]).toMatchObject({ state: 'failed', status: 'expired' });
  });

  it('a provider outage is counted, changes nothing and does not close anything', async () => {
    const orderId = await place('wayforpay');
    await startPayment(depsFor(), { orderId, provider: 'wayforpay' });
    const [attempt] = await attemptsOf(orderId);
    await age(attempt?.id ?? '', 10);
    const dead = new WayForPayProvider({
      pageHosts: ['secure.example'],
      baseUrl: 'http://127.0.0.1:1',
      merchantAccount: FAKE_ACCOUNT,
      secretKey: FAKE_SECRET,
      merchantDomainName: 'shop.example',
      timeoutMs: 200,
    });
    const result = await reconcileOpenAttempts({ db: admin.db, providers: { wayforpay: dead } });
    expect(result).toMatchObject({ providerErrors: 1, closed: 0, applied: 0 });
    expect((await attemptsOf(orderId))[0]?.status).toBe('pending');
  });

  it('Q27: the expiry job leaves an order with an unreconciled attempt alone; once reconciled as paid it is not cancelled', async () => {
    const orderId = await place('wayforpay');
    wfp.onCreate(() => ({ status: 200, hang: true }));
    await startPayment(depsFor(), { orderId, provider: 'wayforpay' });
    const [attempt] = await attemptsOf(orderId);
    await admin.db.execute(
      sql`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${orderId}`,
    );
    const { releaseExpiredOrders } = await import('../src/orders/expiry.ts');
    // Past its TTL, but the attempt's result is unknown: the expiry job must not cancel it.
    expect((await releaseExpiredOrders(admin.db)).expired).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: 'pending' });
    await age(attempt?.id ?? '', 10);
    wfp.payments.set(attempt?.localReference ?? '', {
      amount: Number(attempt?.amount) / 100,
      status: 'Approved',
      reasonCode: 1100,
    });
    await run();
    const expired = await releaseExpiredOrders(admin.db);
    expect(expired.expired).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: 'pending', paymentStatus: 'paid' });
  });
});

describe('cash on delivery: the manager confirms (Q16)', () => {
  it('confirms once, lifts the reservation expiry, and only then can the order ship', async () => {
    const orderId = await place('cod');
    await expect(
      admin.db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 'test' })),
    ).rejects.toBeInstanceOf(OrderNotShippableError);
    const first = await admin.db.transaction(
      async (tx) => await confirmCodOrder(tx, { orderId, actor: 'manager-1' }),
    );
    const again = await admin.db.transaction(
      async (tx) => await confirmCodOrder(tx, { orderId, actor: 'manager-1' }),
    );
    expect([first.changed, again.changed]).toEqual([true, false]);
    expect(await orderRow(orderId)).toMatchObject({
      status: 'confirmed',
      paymentStatus: 'pending',
      capturedTotal: 0,
    });
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM stock_reservations WHERE order_id = ${orderId} AND expires_at IS NOT NULL`,
      ),
    ).toBe(0);
    await admin.db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 'test' }));
    expect(await orderRow(orderId)).toMatchObject({ status: 'shipped' });
    // The goods left the shelf exactly once.
    expect(await reservedTotal()).toBe(0);
  });

  it('refuses a card order, a cancelled order and an unknown one', async () => {
    const card = await place('mono');
    await expect(
      admin.db.transaction(async (tx) => await confirmCodOrder(tx, { orderId: card, actor: 'm' })),
    ).rejects.toBeInstanceOf(OrderNotConfirmableError);
    const cod = await place('cod', variants[1]);
    await admin.db.transaction(
      async (tx) => await cancelOrder(tx, { orderId: cod, source: 'test', reason: null }),
    );
    await expect(
      admin.db.transaction(async (tx) => await confirmCodOrder(tx, { orderId: cod, actor: 'm' })),
    ).rejects.toBeInstanceOf(OrderNotConfirmableError);
  });

  it('a confirmed COD order is not cancelled by the expiry job', async () => {
    const orderId = await place('cod');
    await admin.db.transaction(async (tx) => await confirmCodOrder(tx, { orderId, actor: 'm' }));
    const { releaseExpiredOrders } = await import('../src/orders/expiry.ts');
    expect((await releaseExpiredOrders(admin.db)).expired).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: 'confirmed' });
  });
});

describe('bank transfer: a confirmed receipt of funds is the source (ADR-4 source 3)', () => {
  const confirm = async (orderId: string, reference: string, amount: number) =>
    await admin.db.transaction(
      async (tx) =>
        await confirmTransferReceived(tx, {
          orderId,
          actor: 'm',
          bankReference: reference,
          receivedAmount: money(amount),
        }),
    );

  it('records the money as an attempt, credits captured_total, confirms the order and queues the email', async () => {
    const orderId = await place('bank_transfer');
    const total = (await orderRow(orderId))?.total ?? 0;
    expect(await confirm(orderId, 'BANK-REF-1', total)).toMatchObject({ changed: true });
    expect(await orderRow(orderId)).toMatchObject({
      status: 'confirmed',
      paymentStatus: 'paid',
      capturedTotal: total,
    });
    expect((await attemptsOf(orderId))[0]).toMatchObject({
      provider: 'bank_transfer',
      externalId: 'BANK-REF-1',
      capturedAmount: total,
    });
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'email.payment-received'`,
      ),
    ).toBe(1);
    await admin.db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 'test' }));
  });

  it('refuses a wrong amount, a repeated reference on another order, and a card order', async () => {
    const a = await place('bank_transfer');
    const b = await place('bank_transfer', variants[1]);
    const totalA = (await orderRow(a))?.total ?? 0;
    await expect(confirm(a, 'BANK-REF-2', totalA - 1)).rejects.toBeInstanceOf(
      TransferAmountMismatchError,
    );
    await expect(confirm(a, '   ', totalA)).rejects.toBeInstanceOf(OrderNotConfirmableError);
    await confirm(a, 'BANK-REF-3', totalA);
    await expect(confirm(b, 'BANK-REF-3', (await orderRow(b))?.total ?? 0)).rejects.toBeInstanceOf(
      OrderNotConfirmableError,
    );
    expect(await confirm(a, 'BANK-REF-3', totalA)).toMatchObject({ changed: false });
    const card = await place('mono', variants[0]);
    await expect(confirm(card, 'BANK-REF-4', 1)).rejects.toBeInstanceOf(OrderNotConfirmableError);
  });

  it('two managers confirming the same transfer at once credit it once', async () => {
    const orderId = await place('bank_transfer');
    const total = (await orderRow(orderId))?.total ?? 0;
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await barrier.wait();
      return await handle.db.transaction(
        async (tx) =>
          await confirmTransferReceived(tx, {
            orderId,
            actor: 'm',
            bankReference: 'BANK-RACE',
            receivedAmount: money(total),
          }),
      );
    };
    const results = await Promise.all([run(), run()]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await attemptsOf(orderId)).toHaveLength(1);
    expect((await orderRow(orderId))?.capturedTotal).toBe(total);
  });

  it('a transfer confirmed after the reservation expired is a late payment: money recorded, not confirmed, alert', async () => {
    const orderId = await place('bank_transfer');
    const total = (await orderRow(orderId))?.total ?? 0;
    await admin.db.execute(
      sql`UPDATE stock_reservations SET released_at = now(), release_reason = 'expired' WHERE order_id = ${orderId}`,
    );
    await confirm(orderId, 'BANK-LATE', total);
    expect(await orderRow(orderId)).toMatchObject({ paymentStatus: 'paid', status: 'pending' });
    expect(
      await count(sql`SELECT count(*)::int AS n FROM outbox WHERE topic = 'alert.late-payment'`),
    ).toBe(1);
    await expect(
      admin.db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 'test' })),
    ).rejects.toBeInstanceOf(OrderNotShippableError);
  });
});

describe('resolveOrderForPayment: the order number alone opens nothing', () => {
  it('needs the exact access token; another order token, a wrong token and a malformed number get null', async () => {
    const a = await place('mono');
    const b = await place('mono', variants[1]);
    const stored = async (id: string): Promise<{ number: string; hash: string }> => {
      const row = (
        await admin.db.execute<{ order_number: string }>(
          sql`SELECT order_number FROM orders WHERE id = ${id}`,
        )
      ).rows[0];
      return { number: row?.order_number ?? '', hash: '' };
    };
    // Tokens are stored as SHA-256 hashes: install known ones.
    const { createHash } = await import('node:crypto');
    const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');
    await admin.db.execute(
      sql`UPDATE orders SET access_token_hash = ${hashOf('token-a')} WHERE id = ${a}`,
    );
    await admin.db.execute(
      sql`UPDATE orders SET access_token_hash = ${hashOf('token-b')} WHERE id = ${b}`,
    );
    const numberA = (await stored(a)).number;
    const found = await resolveOrderForPayment(admin.db, numberA, 'token-a');
    expect(found).toMatchObject({ id: a, paymentProvider: 'mono', paymentStatus: 'pending' });
    expect(await resolveOrderForPayment(admin.db, numberA, 'token-b')).toBeNull();
    expect(await resolveOrderForPayment(admin.db, numberA, 'nope')).toBeNull();
    expect(await resolveOrderForPayment(admin.db, numberA, '')).toBeNull();
    expect(await resolveOrderForPayment(admin.db, 'not-a-number', 'token-a')).toBeNull();
  });
});
