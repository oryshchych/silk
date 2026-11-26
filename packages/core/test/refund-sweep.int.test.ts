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
import { RefundBudgetError } from '../src/errors.ts';
import {
  cancelPendingRefund,
  processRefund,
  requestRefund,
  settleRefund,
  type ProviderMap,
} from '../src/payments/refunds.ts';
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

describe('review round 1 (#77): races and failures', () => {
  it('withdraw racing the sweep claim on one operation: exactly one wins, at most one provider call', async () => {
    for (let round = 0; round < 6; round += 1) {
      fake.requests.length = 0;
      const op = await reserve(1_000);
      await age(op, 30);
      const barrier = new Barrier(2);
      const withdraw = async () => {
        const h = world.connect();
        return await h.db.transaction(async (tx) => {
          await barrier.wait();
          return await cancelPendingRefund(tx, op);
        });
      };
      const sweep = async () => {
        const h = world.connect();
        await barrier.wait();
        return await sweepRefunds(deps(h));
      };
      const [withdrawn, swept] = await Promise.all([withdraw(), sweep()]);
      expect(cancelCalls(), `round ${String(round)}`).toBeLessThanOrEqual(1);
      if (withdrawn) {
        expect(await state(op)).toBe('failed');
        expect(cancelCalls()).toBe(0);
        expect(swept.sent).toBe(0);
      } else {
        expect(await state(op)).toBe('succeeded');
        expect(cancelCalls()).toBe(1);
      }
      // Clear the way for the next round: a settled operation holds or frees budget as it should.
      await admin.db.execute(sql`DELETE FROM refund_operations WHERE state = 'failed'`);
      await admin.db.execute(sql`UPDATE refund_operations SET state = 'failed' WHERE id = ${op}`);
      await admin.db.execute(
        sql`UPDATE orders SET refunded_total = 0, payment_status = 'paid' WHERE id = ${orderId}`,
      );
    }
  });

  it('the admin form and the sweep sending the same refund at once: one provider call', async () => {
    const op = await reserve(10_000);
    await age(op, 30);
    const barrier = new Barrier(2);
    const form = async () => {
      const h = world.connect();
      await barrier.wait();
      return await processRefund(deps(h), op);
    };
    const sweep = async () => {
      const h = world.connect();
      await barrier.wait();
      return await sweepRefunds(deps(h));
    };
    await Promise.all([form(), sweep()]);
    expect(cancelCalls()).toBe(1);
    expect(await state(op)).toBe('succeeded');
  });

  it('two people resolving one unknown refund at once: one changes it, the other is a no-op', async () => {
    const op = await reserve(10_000);
    await admin.db.execute(sql`UPDATE refund_operations SET state = 'unknown' WHERE id = ${op}`);
    const barrier = new Barrier(2);
    const resolve = async () => {
      const h = world.connect();
      return await h.db.transaction(async (tx) => {
        await barrier.wait();
        return await settleRefund(tx, {
          operationId: op,
          outcome: { state: 'succeeded', providerReference: null },
          confirmation: { by: null },
        });
      });
    };
    const results = await Promise.all([resolve(), resolve()]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(
      (
        await admin.db.execute<{ r: number }>(
          sql`SELECT refunded_total AS r FROM orders WHERE id = ${orderId}`,
        )
      ).rows[0]?.r,
    ).toBe(10_000);
  });

  it('two unsent refunds where the first cannot be sent: the second still goes, the first stays for the next run', async () => {
    const first = await reserve(10_000);
    // A second payment attempt through a provider that is not registered: sending it throws a routing error.
    const foreign =
      (
        await admin.db.execute<{ id: string }>(
          sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id)
            VALUES (${orderId}, 2, 'wayforpay', 5000, 'succeeded', 'paid', 5000, 'ord-foreign') RETURNING id`,
        )
      ).rows[0]?.id ?? '';
    await admin.db.execute(
      sql`UPDATE orders SET captured_total = captured_total + 5000 WHERE id = ${orderId}`,
    );
    const second =
      (
        await admin.db.execute<{ id: string }>(
          sql`INSERT INTO refund_operations (order_id, payment_attempt_id, amount, state) VALUES (${orderId}, ${foreign}, 1000, 'pending') RETURNING id`,
        )
      ).rows[0]?.id ?? '';
    await age(second, 60);
    await age(first, 30);
    const result = await sweepRefunds(deps());
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(await state(first)).toBe('succeeded');
    expect(await state(second)).toBe('pending');
  });

  it('resolving as returned over the captured total is a TYPED refusal, not a raw constraint error', async () => {
    const op = await reserve(10_000);
    await admin.db.execute(sql`UPDATE refund_operations SET state = 'unknown' WHERE id = ${op}`);
    await admin.db.execute(sql`UPDATE orders SET captured_total = 5000 WHERE id = ${orderId}`);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await settleRefund(tx, {
            operationId: op,
            outcome: { state: 'succeeded', providerReference: null },
            confirmation: { by: null },
          }),
      ),
    ).rejects.toBeInstanceOf(RefundBudgetError);
    expect(await state(op)).toBe('unknown');
  });

  it('the alert row carries ids only', async () => {
    const op = await reserve(10_000);
    await admin.db.execute(sql`UPDATE refund_operations SET state = 'unknown' WHERE id = ${op}`);
    await age(op, 90);
    await sweepRefunds(deps());
    const payload =
      (
        await admin.db.execute<{ payload: Record<string, unknown> }>(
          sql`SELECT payload FROM outbox WHERE topic = 'alert.refund-unresolved'`,
        )
      ).rows[0]?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(['operationId', 'orderId']);
    expect(JSON.stringify(payload)).not.toMatch(/@|\+380|Петренко/);
  });
});
