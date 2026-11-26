/**
 * The admin refund reservation under concurrency, on real Postgres with separate connections:
 * two refunds of one payment can never exceed what was captured, a double submit reserves once,
 * and the amount bounds hold. The provider call is not part of this test (see
 * apps/web/test/orders-refund-edit.int.test.ts for the real MonoProvider over a socket).
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { MonoProvider } from '@store/payments/mono';
import { money } from '@store/shared/money';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import { RefundBudgetError, RefundNotAllowedError } from '../src/errors.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { reserveAdminRefund } from '../src/orders-admin/refund.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const USER = '00000000-0000-4000-8000-0000000000aa';
const providers = {
  mono: new MonoProvider({
    pageHosts: ['pay.example'],
    baseUrl: 'http://127.0.0.1:1',
    token: 't',
    timeoutMs: 100,
  }),
};
let world: TestWorld;
let admin: DbHandle;
let orderId: string;
let total = 0;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  const token = 'tok-refund-admin-cart'.padEnd(20, 'x');
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
  await admin.db.execute(
    sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id)
        SELECT id, 1, 'mono', total, 'succeeded', 'paid', total, 'inv-admin-refund' FROM orders WHERE id = ${orderId}`,
  );
  await admin.db.execute(
    sql`UPDATE orders SET payment_status = 'paid', captured_total = total WHERE id = ${orderId}`,
  );
  total =
    (await admin.db.execute<{ total: number }>(sql`SELECT total FROM orders WHERE id = ${orderId}`))
      .rows[0]?.total ?? 0;
});
afterEach(async () => {
  await world.close();
});

const reserve = async (amount: number | undefined, h: DbHandle = admin) =>
  await h.db.transaction(
    async (tx) =>
      await reserveAdminRefund(tx, {
        orderId,
        amount: amount === undefined ? undefined : money(amount),
        reason: 'test refund',
        actorUserId: USER,
        providers,
      }),
  );
const held = async () =>
  Number(
    (
      await admin.db.execute<{ s: string }>(
        sql`SELECT coalesce(sum(amount), 0)::bigint AS s FROM refund_operations WHERE order_id = ${orderId} AND state IN ('pending','in_flight','unknown','succeeded')`,
      )
    ).rows[0]?.s ?? 0,
  );

describe('admin refund reservation', () => {
  it('two part refunds of 60% each at once: exactly one is reserved, never more than captured', async () => {
    const part = Math.ceil(total * 0.6);
    const barrier = new Barrier(2);
    const attempt = async () => {
      const handle = world.connect();
      try {
        return await handle.db.transaction(async (tx) => {
          await barrier.wait();
          return await reserveAdminRefund(tx, {
            orderId,
            amount: money(part),
            reason: 'race refund',
            actorUserId: USER,
            providers,
          });
        });
      } catch (error) {
        return error;
      }
    };
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => r instanceof RefundBudgetError)).toHaveLength(1);
    expect(results.filter((r) => Array.isArray(r))).toHaveLength(1);
    expect(await held()).toBe(part);
  });

  it('a double submit of a FULL refund reserves once: the second finds nothing left', async () => {
    const barrier = new Barrier(2);
    const attempt = async () => {
      const handle = world.connect();
      try {
        return await handle.db.transaction(async (tx) => {
          await barrier.wait();
          return await reserveAdminRefund(tx, {
            orderId,
            reason: 'double click',
            actorUserId: USER,
            providers,
          });
        });
      } catch (error) {
        return error;
      }
    };
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => Array.isArray(r))).toHaveLength(1);
    expect(results.filter((r) => r instanceof RefundBudgetError)).toHaveLength(1);
    expect(await held()).toBe(total);
  });

  it('partial refunds add up to the captured amount and not a kopiyka more; bounds are enforced', async () => {
    await reserve(1000);
    await reserve(total - 1000);
    expect(await held()).toBe(total);
    await expect(reserve(1)).rejects.toBeInstanceOf(RefundBudgetError);
    await expect(reserve(undefined)).rejects.toBeInstanceOf(RefundBudgetError);
  });

  it.each([0, -5, 1.5, 999_999_999])(
    'amount %s is refused and reserves nothing',
    async (amount) => {
      await expect(reserve(amount)).rejects.toThrow();
      expect(await held()).toBe(0);
    },
  );

  it('a refund while a webhook-side operation already holds budget respects it', async () => {
    // A refund operation another path (reconciliation, an earlier unknown one) already holds.
    await admin.db.execute(
      sql`INSERT INTO refund_operations (order_id, payment_attempt_id, amount, state)
          SELECT ${orderId}::uuid, id, ${total - 500}, 'unknown'::operation_state FROM payment_attempts WHERE order_id = ${orderId}`,
    );
    await expect(reserve(501)).rejects.toBeInstanceOf(RefundBudgetError);
    await reserve(500);
    expect(await held()).toBe(total);
  });

  it('refuses an order with nothing captured, an unknown order and a provider that is not registered', async () => {
    await admin.db.execute(
      sql`UPDATE payment_attempts SET captured_amount = 0 WHERE order_id = ${orderId}`,
    );
    await expect(reserve(100)).rejects.toBeInstanceOf(RefundNotAllowedError);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await reserveAdminRefund(tx, {
            orderId: '00000000-0000-4000-8000-00000000dead',
            reason: 'x y z',
            actorUserId: USER,
            providers,
          }),
      ),
    ).rejects.toThrow();
    await admin.db.execute(
      sql`UPDATE payment_attempts SET captured_amount = ${total} WHERE order_id = ${orderId}`,
    );
    await expect(
      admin.db.transaction(
        async (tx) =>
          await reserveAdminRefund(tx, {
            orderId,
            amount: money(100),
            reason: 'no route',
            actorUserId: USER,
            providers: {},
          }),
      ),
    ).rejects.toThrow();
    expect(await held()).toBe(0);
  });
});
