/**
 * The refund sweep on real Postgres, separate connections, the real MonoProvider over a socket
 * against the local fake: a refund nobody sent is sent once, one whose answer is unknown is never
 * guessed (an alert, once), and ages are judged by the database clock.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { MonoProvider } from '@store/payments/mono';
import { startFakeMono, type FakeMono } from '@store/payments/test/fake-mono';
import { money } from '@store/shared/money';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { sweepRefunds } from '../src/payments/refund-sweep.ts';
import { requestRefund, type ProviderMap } from '../src/payments/refunds.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let fake: FakeMono;
let providers: ProviderMap;
let world: TestWorld;
let admin: DbHandle;
let orderId: string;
let attemptId: string;

beforeAll(async () => {
  fake = await startFakeMono();
  providers = {
    mono: new MonoProvider({
      pageHosts: ['pay.example'],
      baseUrl: fake.baseUrl,
      token: 't',
      timeoutMs: 300,
    }),
  };
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  fake.requests.length = 0;
  world = await createWorld();
  admin = world.connect(2);
  const token = 'tok-refund-sweep-cart'.padEnd(20, 'x');
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
        contact: { email: 'b@example.com', phone: '+380501112233', name: 'Петренко Іван' },
        delivery: { method: 'pickup' },
        paymentProvider: 'mono',
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  orderId = placed.orderId;
  attemptId =
    (
      await admin.db.execute<{ id: string }>(
        sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id)
          SELECT id, 1, 'mono', total, 'succeeded', 'paid', total, 'inv-sweep' FROM orders WHERE id = ${orderId} RETURNING id`,
      )
    ).rows[0]?.id ?? '';
  await admin.db.execute(
    sql`UPDATE orders SET payment_status = 'paid', captured_total = total WHERE id = ${orderId}`,
  );
});
afterEach(async () => {
  await world.close();
});

const reserve = async (amount: number) =>
  (
    await admin.db.transaction(
      async (tx) =>
        await requestRefund(tx, {
          orderId,
          attemptId,
          amount: money(amount),
          reason: 'sweep test',
          initiatedBy: null,
          providers,
        }),
    )
  ).operationId;
const age = async (operationId: string, minutes: number) =>
  await admin.db.execute(
    sql`UPDATE refund_operations SET created_at = now() - make_interval(mins => ${minutes}) WHERE id = ${operationId}`,
  );
const state = async (operationId: string) =>
  (
    await admin.db.execute<{ state: string }>(
      sql`SELECT state FROM refund_operations WHERE id = ${operationId}`,
    )
  ).rows[0]?.state;
const deps = (h: DbHandle = admin) => ({
  providers,
  runInTransaction: async <T>(fn: Parameters<DbHandle['db']['transaction']>[0]) =>
    (await h.db.transaction(fn)) as T,
});
const cancelCalls = () => fake.requests.filter((r) => r.url.includes('cancel')).length;
const alerts = async () =>
  (await admin.db.execute(sql`SELECT 1 FROM outbox WHERE topic = 'alert.refund-unresolved'`)).rows
    .length;

describe('pending: reserved but never sent', () => {
  it('an old one is sent once and settles the order; a fresh one is left alone', async () => {
    const old = await reserve(10_000);
    const fresh = await reserve(5_000);
    await age(old, 30);
    const result = await sweepRefunds(deps());
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(await state(old)).toBe('succeeded');
    expect(await state(fresh)).toBe('pending');
    expect(cancelCalls()).toBe(1);
    expect(
      (
        await admin.db.execute<{ r: number }>(
          sql`SELECT refunded_total AS r FROM orders WHERE id = ${orderId}`,
        )
      ).rows[0]?.r,
    ).toBe(10_000);
  });

  it('two sweeps at once (separate connections) call the provider once', async () => {
    const op = await reserve(10_000);
    await age(op, 30);
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await barrier.wait();
      return await sweepRefunds(deps(handle));
    };
    const results = await Promise.all([run(), run()]);
    expect(results.reduce((total, r) => total + r.sent, 0)).toBe(1);
    expect(cancelCalls()).toBe(1);
    expect(await state(op)).toBe('succeeded');
  });

  it('an operation that cannot be sent now stays pending and is counted, not thrown', async () => {
    const op = await reserve(10_000);
    await age(op, 30);
    const result = await sweepRefunds({ ...deps(), providers: {} });
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(await state(op)).toBe('pending');
  });

  it('a provider that does not answer leaves it unknown, never failed', async () => {
    const op = await reserve(10_000);
    await age(op, 30);
    fake.onCancel(() => ({ status: 200, hang: true }));
    await sweepRefunds(deps());
    expect(await state(op)).toBe('unknown');
  });
});

describe('in flight or unknown: never guessed', () => {
  it.each(['in_flight', 'unknown'])(
    'a %s refund older than an hour raises ONE alert and no provider call; the budget stays held',
    async (kind) => {
      const op = await reserve(10_000);
      await admin.db.execute(
        sql`UPDATE refund_operations SET state = ${kind}::operation_state WHERE id = ${op}`,
      );
      await age(op, 90);
      const first = await sweepRefunds(deps());
      expect(first).toMatchObject({ sent: 0, alerted: 1 });
      const second = await sweepRefunds(deps());
      expect(second.alerted).toBe(0);
      expect(await alerts()).toBe(1);
      expect(cancelCalls()).toBe(0);
      expect(await state(op)).toBe(kind);
      await expect(reserve(Number.MAX_SAFE_INTEGER)).rejects.toThrow();
    },
  );

  it('one that is younger than an hour is not alerted yet', async () => {
    const op = await reserve(10_000);
    await admin.db.execute(sql`UPDATE refund_operations SET state = 'unknown' WHERE id = ${op}`);
    await age(op, 20);
    expect((await sweepRefunds(deps())).alerted).toBe(0);
    expect(await alerts()).toBe(0);
  });

  it('settled operations are ignored', async () => {
    const op = await reserve(10_000);
    await admin.db.execute(sql`UPDATE refund_operations SET state = 'succeeded' WHERE id = ${op}`);
    await age(op, 500);
    expect(await sweepRefunds(deps())).toEqual({ sent: 0, failed: 0, alerted: 0 });
  });
});
