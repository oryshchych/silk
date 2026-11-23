/**
 * Refunds on real Postgres with the real MonoProvider against the local fake
 * Mono (phase 0.5 criterion 12: two simultaneous refunds of one payment can
 * never exceed what was captured). Separate connections, barriers, and a held
 * transaction with an observed blocked backend as the proof of overlap.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { orders, refundOperations } from '@store/db/schema';
import { MonoProvider } from '@store/payments/mono';
import type { PaymentProvider } from '@store/payments/types';
import { money } from '@store/shared/money';
import { startFakeMono, type FakeMono } from '@store/payments/test/fake-mono';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import {
  OrderNotShippableError,
  RefundBudgetError,
  RefundNotAllowedError,
  RefundRoutingError,
} from '../src/errors.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { cancelOrder, shipOrder } from '../src/orders/fulfilment.ts';
import {
  cancelPendingRefund,
  claimRefund,
  processRefund,
  requestFullRefund,
  requestRefund,
  routesOf,
  settleRefund,
  type RefundDeps,
  type RefundRequest,
} from '../src/payments/refunds.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let fake: FakeMono;
let mono: MonoProvider;
let world: TestWorld;
let admin: DbHandle;
let orderId: string;
let attemptId: string;
let total: number;

beforeAll(async () => {
  fake = await startFakeMono();
  mono = new MonoProvider({ baseUrl: fake.baseUrl, token: 't', timeoutMs: 300 });
});

afterAll(async () => {
  await fake.close();
});

beforeEach(async () => {
  fake.requests.length = 0;
  fake.onCancel(() => ({ status: 200, json: { status: 'success' } }));
  world = await createWorld();
  admin = world.connect(2);
  const token = 'tok-refund-test-cart-x';
  await admin.db.transaction(async (tx) => {
    await setCartItem(tx, {
      cartToken: token,
      variantId: world.fixture.variantIds[0],
      quantity: 1,
    });
  });
  const view = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await admin.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: view.intentId,
        ownerToken: token,
        contact: { email: 'b@example.com', phone: '+380501112233', name: 'Buyer' },
        delivery: { method: 'pickup' },
        paymentProvider: 'mono',
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  orderId = placed.orderId;
  attemptId = await paidAttempt('inv-1', 'mono');
  const [order] = await admin.db.select().from(orders).where(eq(orders.id, orderId));
  total = order?.total ?? 0;
});

afterEach(async () => {
  await world.close();
});

/** Test setup only: the webhook flow that really does this is covered in webhook.int.test.ts. */
async function paidAttempt(externalId: string, provider: 'mono' | 'wayforpay'): Promise<string> {
  const number = (
    await admin.db.execute<{ n: number }>(
      sql`SELECT coalesce(max(attempt_number), 0)::int + 1 AS n FROM payment_attempts WHERE order_id = ${orderId}`,
    )
  ).rows[0]?.n;
  const inserted = await admin.db.execute<{ id: string }>(
    sql`INSERT INTO payment_attempts
          (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id)
        SELECT id, ${number ?? 1}, ${provider}, total, 'succeeded', 'paid', total, ${externalId}
          FROM orders WHERE id = ${orderId} RETURNING id`,
  );
  await admin.db.execute(
    sql`UPDATE orders SET payment_status = 'paid',
          captured_total = (SELECT sum(captured_amount) FROM payment_attempts WHERE order_id = ${orderId})
        WHERE id = ${orderId}`,
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('attempt insert returned no row');
  return id;
}

const wayforpayStandIn: PaymentProvider = {
  code: 'wayforpay',
  createPayment: async (a) => await mono.createPayment(a),
  getPaymentStatus: async (id) => await mono.getPaymentStatus(id),
  verifyWebhook: async (b, h) => await mono.verifyWebhook(b, h),
  refund: async (r) => await mono.refund(r),
  buildWebhookResponse: () => mono.buildWebhookResponse(),
};

const deps = (handle: DbHandle = world.connect()): RefundDeps => ({
  providers: { mono },
  runInTransaction: async (fn) => await handle.db.transaction(async (tx) => await fn(tx)),
});

const request = (over: Partial<RefundRequest> = {}): RefundRequest => ({
  orderId,
  attemptId,
  amount: money(total),
  reason: 'customer request',
  initiatedBy: null,
  providers: { mono },
  ...over,
});

const reserve = async (over: Partial<RefundRequest> = {}, handle: DbHandle = world.connect()) =>
  await handle.db.transaction(async (tx) => await requestRefund(tx, request(over)));

const cancelCalls = (): number =>
  fake.requests.filter((r) => r.url === '/api/merchant/invoice/cancel').length;

async function orderMoney() {
  const [row] = await admin.db
    .select({
      payment: orders.paymentStatus,
      captured: orders.capturedTotal,
      refunded: orders.refundedTotal,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row;
}

async function opStates(): Promise<string[]> {
  const rows = await admin.db
    .select({ state: refundOperations.state })
    .from(refundOperations)
    .orderBy(refundOperations.createdAt);
  return rows.map((r) => r.state);
}

async function waitUntilBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('nothing ever blocked on a lock: the operations did not overlap');
}

describe('a full refund through refund_operations', () => {
  it('reserves, calls the provider once with our reference, settles, and marks the order refunded', async () => {
    const [reservation] = await world
      .connect()
      .db.transaction(async (tx) => await requestFullRefund(tx, { ...request() }));
    if (reservation === undefined) throw new Error('no reservation');
    expect(reservation.amount).toBe(total);
    expect(await opStates()).toEqual(['pending']);

    expect(await processRefund(deps(), reservation.operationId)).toEqual({
      called: true,
      state: 'succeeded',
    });
    expect(cancelCalls()).toBe(1);
    const sent: unknown = JSON.parse(
      fake.requests.findLast((r) => r.url.endsWith('/cancel'))?.body ?? '{}',
    );
    expect(sent).toEqual({
      invoiceId: 'inv-1',
      extRef: reservation.localReference,
      amount: total,
    });
    expect(await opStates()).toEqual(['succeeded']);
    expect(await orderMoney()).toEqual({ payment: 'refunded', captured: total, refunded: total });
    expect(
      await admin.db.execute(
        sql`SELECT 1 FROM order_status_history WHERE source = 'refund' AND to_status = 'refunded'`,
      ),
    ).toHaveProperty('rowCount', 1);

    // nothing is left: a second full refund is refused, no second provider call
    await expect(
      world.connect().db.transaction(async (tx) => await requestFullRefund(tx, request())),
    ).rejects.toBeInstanceOf(RefundBudgetError);
    expect(cancelCalls()).toBe(1);
  });

  it('a partial refund leaves the order partially_refunded and the rest refundable', async () => {
    const reservation = await reserve({ amount: money(30000) });
    await processRefund(deps(), reservation.operationId);
    expect(await orderMoney()).toEqual({
      payment: 'partially_refunded',
      captured: total,
      refunded: 30000,
    });
    const rest = await reserve({ amount: money(total - 30000) });
    await processRefund(deps(), rest.operationId);
    expect(await orderMoney()).toEqual({ payment: 'refunded', captured: total, refunded: total });
  });
});

describe('criterion 12: two simultaneous refunds of one payment', () => {
  it('two full refunds on separate connections: exactly one is reserved, the sum never exceeds the capture', async () => {
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await reserve({}, handle);
    };
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(RefundBudgetError);
    const sum = await admin.db.execute<{ s: number }>(
      sql`SELECT coalesce(sum(amount), 0)::int AS s FROM refund_operations`,
    );
    expect(sum.rows[0]?.s).toBeLessThanOrEqual(total);
  });

  it('two 60 percent refunds: the second waits behind the first (observed), then is refused', async () => {
    const sixty = Math.floor((total * 6) / 10);
    const handle = world.connect();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const first = handle.db.transaction(async (tx) => {
      const reservation = await requestRefund(tx, request({ amount: money(sixty) }));
      ready();
      await gate; // the first transaction stays open, holding the order and attempt locks
      return reservation;
    });
    await started;
    const second = reserve({ amount: money(sixty) }).catch((e: unknown) => e);
    await waitUntilBlocked(); // the second request really queued behind the first
    release();
    await first;
    expect(await second).toBeInstanceOf(RefundBudgetError);
    expect(await opStates()).toEqual(['pending']);
  });

  it('five parallel executions of ONE reserved refund call the provider once', async () => {
    const reservation = await reserve();
    const barrier = new Barrier(5);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await processRefund(deps(handle), reservation.operationId);
      }),
    );
    expect(results.filter((r) => r.called)).toHaveLength(1);
    expect(cancelCalls()).toBe(1);
    expect(await orderMoney()).toMatchObject({ refunded: total });
  });
});

describe('uncertain outcomes never free the budget by themselves', () => {
  it('a timeout is unknown, holds the budget, and is never retried', async () => {
    fake.onCancel(() => ({ status: 200, hang: true }));
    const reservation = await reserve();
    expect(await processRefund(deps(), reservation.operationId)).toEqual({
      called: true,
      state: 'unknown',
    });
    expect(await opStates()).toEqual(['unknown']);
    expect(await orderMoney()).toMatchObject({ payment: 'paid', refunded: 0 });
    const before = cancelCalls();

    // running it again does not call the provider (the operation is past pending)
    expect(await processRefund(deps(), reservation.operationId)).toMatchObject({ called: false });
    expect(cancelCalls()).toBe(before);
    // and the held budget refuses a second refund of the same money
    await expect(reserve()).rejects.toBeInstanceOf(RefundBudgetError);

    // reconciliation settles it: provider confirms -> succeeded, the order is refunded
    await world.connect().db.transaction(async (tx) => {
      await settleRefund(tx, {
        operationId: reservation.operationId,
        outcome: { state: 'succeeded', providerReference: null },
        confirmation: { by: null },
      });
    });
    expect(await orderMoney()).toMatchObject({ payment: 'refunded', refunded: total });
  });

  it('unknown resolved as failed frees the budget for a new refund', async () => {
    fake.onCancel(() => ({ status: 503 }));
    const reservation = await reserve();
    await processRefund(deps(), reservation.operationId);
    expect(await opStates()).toEqual(['unknown']);
    await world.connect().db.transaction(async (tx) => {
      await settleRefund(tx, {
        operationId: reservation.operationId,
        outcome: { state: 'failed', error: 'provider says it never happened' },
        confirmation: { by: null },
      });
    });
    await expect(reserve()).resolves.toMatchObject({ amount: total });
  });

  it('a definite refusal is failed and frees the budget at once', async () => {
    fake.onCancel(() => ({ status: 400, json: {} }));
    const reservation = await reserve();
    expect(await processRefund(deps(), reservation.operationId)).toMatchObject({ state: 'failed' });
    expect(await orderMoney()).toMatchObject({ payment: 'paid', refunded: 0 });
    await expect(reserve()).resolves.toBeDefined();
  });

  it('a refund still processing at the provider holds the budget and does not change the order', async () => {
    fake.onCancel(() => ({ status: 200, json: { status: 'processing' } }));
    const reservation = await reserve();
    expect(await processRefund(deps(), reservation.operationId)).toMatchObject({
      state: 'in_flight',
    });
    expect(await orderMoney()).toMatchObject({ payment: 'paid', refunded: 0 });
    await expect(reserve()).rejects.toBeInstanceOf(RefundBudgetError);
  });

  it('a crash after the claim, before the provider call, leaves the operation in flight and sends nothing', async () => {
    const reservation = await reserve();
    const before = cancelCalls();
    const crashing: RefundDeps = {
      providers: {
        mono: Object.assign(Object.create(mono) as MonoProvider, {
          refund: () => Promise.reject(new Error('process died before the call')),
        }),
      },
      runInTransaction: deps().runInTransaction,
    };
    // the provider wrapper throws: that is reported as unknown (budget held), never retried
    expect(await processRefund(crashing, reservation.operationId)).toMatchObject({
      state: 'unknown',
    });
    expect(cancelCalls()).toBe(before);
    expect(await processRefund(deps(), reservation.operationId)).toMatchObject({ called: false });
    expect(cancelCalls()).toBe(before);
  });
});

describe('routing and guards', () => {
  it('an attempt paid through another provider has no route: refused, nothing reserved', async () => {
    const other = await paidAttempt('wfp-1', 'wayforpay');
    await expect(reserve({ attemptId: other })).rejects.toBeInstanceOf(RefundRoutingError);
    expect(await opStates()).toEqual([]);
  });

  it('routes a refund to the attempt that took the money: two paid attempts, two operations', async () => {
    await paidAttempt('inv-2', 'mono');
    const reservations = await world
      .connect()
      .db.transaction(async (tx) => await requestFullRefund(tx, request()));
    expect(reservations).toHaveLength(2);
    for (const r of reservations) await processRefund(deps(), r.operationId);
    const invoices = fake.requests
      .filter((r) => r.url.endsWith('/cancel'))
      .map((r) => (JSON.parse(r.body) as { invoiceId: string }).invoiceId)
      .toSorted();
    expect(invoices).toEqual(['inv-1', 'inv-2']);
    expect(await orderMoney()).toMatchObject({
      payment: 'refunded',
      refunded: total * 2,
      captured: total * 2,
    });
  });

  it.each([0, -5])('amount %s is refused', async (amount) => {
    await expect(reserve({ amount: money(amount) })).rejects.toBeInstanceOf(RefundBudgetError);
  });

  it('a fractional amount cannot even be built (Money refuses it)', () => {
    expect(() => money(1.5)).toThrow(RangeError);
  });

  it('more than was captured is refused, and so is an attempt without a capture', async () => {
    await expect(reserve({ amount: money(total + 1) })).rejects.toBeInstanceOf(RefundBudgetError);
    await admin.db.execute(sql`UPDATE payment_attempts SET captured_amount = 0, status = 'failed'`);
    await expect(reserve()).rejects.toBeInstanceOf(RefundNotAllowedError);
  });

  it('a failure after the reservation rolls the operation and its audit row back', async () => {
    await expect(
      world.connect().db.transaction(async (tx) => {
        await requestRefund(tx, request());
        throw new Error('crash after the reservation');
      }),
    ).rejects.toThrow('crash');
    expect(await opStates()).toEqual([]);
    const audit = await admin.db.execute(sql`SELECT 1 FROM audit_log WHERE action = 'refund'`);
    expect(audit.rowCount).toBe(0);
    await expect(reserve()).resolves.toBeDefined();
  });

  it('settling is idempotent: a second settle changes nothing and never refunds twice', async () => {
    const reservation = await reserve();
    await processRefund(deps(), reservation.operationId);
    const again = await world.connect().db.transaction(
      async (tx) =>
        await settleRefund(tx, {
          operationId: reservation.operationId,
          outcome: { state: 'succeeded', providerReference: null },
          confirmation: { by: null },
        }),
    );
    expect(again).toEqual({ changed: false, state: 'succeeded' });
    expect(await orderMoney()).toMatchObject({ refunded: total });
  });
});

describe('review round: shipping, cancelling and recovery around a refund', () => {
  it('an order whose refund is reserved, in flight or unknown does not ship (goods AND money)', async () => {
    const reservation = await reserve();
    await expect(
      world.connect().db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 't' })),
    ).rejects.toBeInstanceOf(OrderNotShippableError);

    fake.onCancel(() => ({ status: 200, hang: true }));
    await processRefund(deps(), reservation.operationId); // now unknown
    await expect(
      world.connect().db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 't' })),
    ).rejects.toThrow(/refund/);

    // the held budget also refuses another refund of the same money
    await expect(reserve({ amount: money(1) })).rejects.toBeInstanceOf(RefundBudgetError);
  });

  it('a withdrawn pending refund frees the order: it ships', async () => {
    const reservation = await reserve();
    expect(
      await world
        .connect()
        .db.transaction(async (tx) => await cancelPendingRefund(tx, reservation.operationId)),
    ).toBe(true);
    await expect(
      world.connect().db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 't' })),
    ).resolves.toMatchObject({ changed: true });
  });

  it('cancelling an order with a refund already reserved announces no second refund', async () => {
    await reserve();
    await world
      .connect()
      .db.transaction(async (tx) => await cancelOrder(tx, { orderId, source: 't', reason: null }));
    const alerts = await admin.db.execute(
      sql`SELECT 1 FROM outbox WHERE topic = 'alert.refund-due'`,
    );
    expect(alerts.rowCount).toBe(0);
  });

  it('ship racing a refund reservation: the refund is always reserved, the shipment either happens or is refused, never half', async () => {
    const barrier = new Barrier(2);
    const run = async (kind: 'ship' | 'refund') => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return kind === 'ship'
        ? await handle.db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 't' }))
        : await reserve({}, handle);
    };
    const [shipped, refunded] = await Promise.allSettled([run('ship'), run('refund')]);

    // A refund after shipping is legitimate (a return), so the reservation never fails here.
    expect(refunded.status).toBe('fulfilled');
    expect(await opStates()).toEqual(['pending']);

    // Timestamps cannot order two transactions (now() is the transaction START), so the check is
    // on the outcome: shipped means the goods left, refused means nothing moved at all.
    const stock = await admin.db.execute<{ stock: number; reserved: number }>(
      sql`SELECT stock_quantity AS stock, reserved_quantity AS reserved FROM product_variants
           WHERE id = ${world.fixture.variantIds[0]}`,
    );
    const status = await admin.db.execute<{ status: string }>(
      sql`SELECT status FROM orders WHERE id = ${orderId}`,
    );
    if (shipped.status === 'fulfilled') {
      expect(status.rows[0]?.status).toBe('shipped');
      expect(stock.rows[0]).toEqual({ stock: 0, reserved: 0 });
    } else {
      expect(shipped.reason).toBeInstanceOf(OrderNotShippableError);
      expect(status.rows[0]?.status).toBe('pending');
      expect(stock.rows[0]).toEqual({ stock: 1, reserved: 1 });
    }
  });

  it('routes registered at reservation but missing at execution: nothing is sent, the reservation stays pending and can be withdrawn', async () => {
    const other = await paidAttempt('wfp-2', 'wayforpay');
    const reservation = await reserve({
      attemptId: other,
      providers: { mono, wayforpay: wayforpayStandIn },
    });
    const before = cancelCalls();
    await expect(processRefund(deps(), reservation.operationId)).rejects.toBeInstanceOf(
      RefundRoutingError,
    );
    expect(cancelCalls()).toBe(before);
    expect(await opStates()).toEqual(['pending']); // not stuck in flight
    expect(
      await world
        .connect()
        .db.transaction(async (tx) => await cancelPendingRefund(tx, reservation.operationId)),
    ).toBe(true);
    expect(await opStates()).toEqual(['failed']);
  });

  it('a REAL crash after the claim: in flight, the provider never called, never re-sent blindly', async () => {
    const reservation = await reserve();
    await world
      .connect()
      .db.transaction(
        async (tx) => await claimRefund(tx, reservation.operationId, routesOf({ mono })),
      ); // the process died right after this commit
    expect(await opStates()).toEqual(['in_flight']);
    const before = cancelCalls();
    expect(await processRefund(deps(), reservation.operationId)).toEqual({
      called: false,
      state: 'in_flight',
    });
    expect(cancelCalls()).toBe(before);
    await expect(reserve()).rejects.toBeInstanceOf(RefundBudgetError); // budget stays held
  });

  it('an unknown refund never turns back into in flight, and a pending one cannot be settled at all', async () => {
    fake.onCancel(() => ({ status: 200, hang: true }));
    const reservation = await reserve();
    const settle = async (
      operationId: string,
      outcome: Parameters<typeof settleRefund>[1]['outcome'],
    ) =>
      await world
        .connect()
        .db.transaction(
          async (tx) =>
            await settleRefund(tx, { operationId, outcome, confirmation: { by: null } }),
        );
    // pending: never claimed, so it cannot be closed (not even with a confirmation)
    await expect(
      settle(reservation.operationId, { state: 'failed', error: 'x' }),
    ).rejects.toBeInstanceOf(RefundNotAllowedError);

    await processRefund(deps(), reservation.operationId); // now unknown
    expect(
      await settle(reservation.operationId, { state: 'in_flight', providerReference: null }),
    ).toMatchObject({
      changed: false,
    });
    expect(
      await settle(reservation.operationId, { state: 'unknown', error: 'again' }),
    ).toMatchObject({
      changed: false,
    });
    expect(await opStates()).toEqual(['unknown']);
    await expect(reserve()).rejects.toBeInstanceOf(RefundBudgetError);
  });

  it('settleRefund needs a confirmation by type, and it leaves an audit row naming who confirmed', async () => {
    fake.onCancel(() => ({ status: 200, hang: true }));
    const reservation = await reserve();
    await processRefund(deps(), reservation.operationId);
    await world.connect().db.transaction(async (tx) => {
      await settleRefund(tx, {
        operationId: reservation.operationId,
        outcome: { state: 'failed', error: 'provider says it never happened' },
        confirmation: { by: null },
      });
    });
    const audit = await admin.db.execute(
      sql`SELECT 1 FROM audit_log WHERE action = 'refund' AND diff ->> 'confirmed' = 'failed'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('settling twice leaves exactly one refund-issued outbox row', async () => {
    const reservation = await reserve();
    await processRefund(deps(), reservation.operationId);
    await world.connect().db.transaction(async (tx) => {
      await settleRefund(tx, {
        operationId: reservation.operationId,
        outcome: { state: 'succeeded', providerReference: null },
        confirmation: { by: null },
      });
    });
    const rows = await admin.db.execute(
      sql`SELECT 1 FROM outbox WHERE topic = 'email.refund-issued' AND dedup_key = ${`refund:${reservation.operationId}`}`,
    );
    expect(rows.rowCount).toBe(1);
  });

  it('five parallel settles of one in-flight operation change it once and refund once', async () => {
    fake.onCancel(() => ({ status: 200, json: { status: 'processing' } }));
    const reservation = await reserve();
    await processRefund(deps(), reservation.operationId); // in_flight
    const barrier = new Barrier(5);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await handle.db.transaction(
          async (tx) =>
            await settleRefund(tx, {
              operationId: reservation.operationId,
              outcome: { state: 'succeeded', providerReference: null },
              confirmation: { by: null },
            }),
        );
      }),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await orderMoney()).toMatchObject({ payment: 'refunded', refunded: total });
  });

  it('a full refund racing a partial one reserves at most the captured amount', async () => {
    const barrier = new Barrier(2);
    const handleFull = world.connect();
    const handlePart = world.connect();
    await handleFull.db.execute(sql`SELECT 1`);
    await handlePart.db.execute(sql`SELECT 1`);
    const full = (async () => {
      await barrier.wait();
      return await handleFull.db.transaction(async (tx) => await requestFullRefund(tx, request()));
    })();
    const part = (async () => {
      await barrier.wait();
      return await reserve({ amount: money(1000) }, handlePart);
    })();
    await Promise.allSettled([full, part]);
    const sum = await admin.db.execute<{ s: number }>(
      sql`SELECT coalesce(sum(amount), 0)::int AS s FROM refund_operations`,
    );
    // whichever came first, the other took exactly the rest or was refused: the whole capture
    expect(sum.rows[0]?.s).toBe(total);
  });

  it('a full refund is all-or-nothing: one attempt without a route refuses the whole request', async () => {
    await paidAttempt('wfp-3', 'wayforpay');
    await expect(
      world.connect().db.transaction(async (tx) => await requestFullRefund(tx, request())),
    ).rejects.toBeInstanceOf(RefundRoutingError);
    expect(await opStates()).toEqual([]);
  });

  it('a long free-text reason is refused (it can carry customer data)', async () => {
    await expect(reserve({ reason: 'x'.repeat(201) })).rejects.toBeInstanceOf(
      RefundNotAllowedError,
    );
  });
});

describe('review round 2: the order lock matters, partial refunds, shipping afterwards', () => {
  /** Holds a refund reservation open; returns release/done like the other overlap proofs. */
  async function heldReservation(over: Partial<RefundRequest> = {}) {
    const handle = world.connect();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const done = handle.db.transaction(async (tx) => {
      const reservation = await requestRefund(tx, request(over));
      ready();
      await gate;
      return reservation;
    });
    done.catch(() => {
      ready();
    });
    await started;
    return { release, done };
  }

  it('ship waits for a held refund reservation (the ORDER lock), then is refused', async () => {
    const held = await heldReservation();
    const shipping = world
      .connect()
      .db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 't' }))
      .catch((e: unknown) => e);
    await waitUntilBlocked();
    held.release();
    await held.done;
    expect(await shipping).toBeInstanceOf(OrderNotShippableError);
  });

  it('cancel waits for a held refund reservation, then announces no second refund', async () => {
    const held = await heldReservation();
    const cancelling = world
      .connect()
      .db.transaction(async (tx) => await cancelOrder(tx, { orderId, source: 't', reason: null }))
      .catch((e: unknown) => e);
    await waitUntilBlocked();
    held.release();
    await held.done;
    expect(await cancelling).toMatchObject({ changed: true });
    const alerts = await admin.db.execute(
      sql`SELECT 1 FROM outbox WHERE topic = 'alert.refund-due'`,
    );
    expect(alerts.rowCount).toBe(0);
  });

  it('a full refund queues behind a held partial reservation and takes exactly the rest', async () => {
    const held = await heldReservation({ amount: money(1000) });
    const full = world
      .connect()
      .db.transaction(async (tx) => await requestFullRefund(tx, request()))
      .catch((e: unknown) => e);
    await waitUntilBlocked();
    held.release();
    await held.done;
    const reservations = await full;
    if (!Array.isArray(reservations)) throw new Error('the full refund must have been reserved');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ amount: total - 1000 });
    const sum = await admin.db.execute<{ s: number }>(
      sql`SELECT coalesce(sum(amount), 0)::int AS s FROM refund_operations`,
    );
    expect(sum.rows[0]?.s).toBe(total);
  });

  it('after a SUCCEEDED partial refund the order is partially_refunded and does not ship', async () => {
    const reservation = await reserve({ amount: money(30000) });
    await processRefund(deps(), reservation.operationId);
    expect(await orderMoney()).toMatchObject({ payment: 'partially_refunded' });
    await expect(
      world.connect().db.transaction(async (tx) => await shipOrder(tx, { orderId, source: 't' })),
    ).rejects.toBeInstanceOf(OrderNotShippableError);
  });
});
