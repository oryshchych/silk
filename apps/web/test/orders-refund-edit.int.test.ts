/**
 * Admin refund and item edit through the real action chain on Postgres. The refund goes to the
 * real MonoProvider over a real socket (the local fake Mono): nothing here can reach a real
 * provider. Only the request-bound inputs (session, Origin) are supplied by the test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { createOrder } from '@store/core/orders';
import { setCartItem, startCheckout } from '@store/core/cart';
import { authUsers, settings } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import { MonoProvider } from '@store/payments/mono';
import { startFakeMono, type FakeMono } from '@store/payments/test/fake-mono';

const USER = '00000000-0000-4000-8000-0000000000aa';
const state: { role: AdminSession['role']; handle: Db | null; mono: MonoProvider | null } =
  vi.hoisted(() => ({ role: 'admin', handle: null, mono: null }));

async function wired() {
  const { createAdminAction: create } = await import('../src/lib/admin/action');
  const { createRateLimiter: limiter } = await import('../src/lib/rate-limit');
  return {
    adminAction: create({
      originOk: () => Promise.resolve(true),
      session: () =>
        Promise.resolve({
          kind: 'full',
          session: { sid: 's', userId: USER, email: 'refund@example.test', role: state.role },
        } satisfies ResolvedSession),
      transaction: async (fn) => {
        if (state.handle === null) throw new Error('no database');
        return await state.handle.transaction(fn);
      },
      client: () => Promise.resolve('203.0.113.9'),
      limiter: limiter({ limit: 1_000, windowMs: 60_000 }),
    }),
  };
}
vi.mock('@/lib/admin/bound-action', wired);
vi.mock('../src/lib/admin/bound-action', wired);
const providers = () => (state.mono === null ? {} : { mono: state.mono });
vi.mock('@/lib/waybill-carrier', () => ({ getWaybillCarrier: () => Promise.resolve(null) }));
vi.mock('@/lib/payment-providers', () => ({
  getPaymentProviders: () => Promise.resolve(providers()),
}));
vi.mock('@/lib/db', () => ({
  getDb: () =>
    state.handle === null
      ? Promise.reject(new Error('no database'))
      : Promise.resolve(state.handle),
}));

const actions = await import('../src/actions/admin-orders');

let testDb: TestDatabase;
let handle: DbHandle;
let fake: FakeMono;
let variantId: string;
let seq = 0;

beforeAll(async () => {
  fake = await startFakeMono();
  state.mono = new MonoProvider({
    pageHosts: ['pay.example'],
    baseUrl: fake.baseUrl,
    token: 't',
    timeoutMs: 300,
  });
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  variantId = (
    await handle.db.transaction(async (tx) => {
      await tx.insert(settings).values({
        key: 'payment_providers',
        value: { mono: true, wayforpay: true, cod: true, bank_transfer: true },
      });
      return await seedMoneySkeleton(tx);
    })
  ).variantIds[0];
  await handle.pool.query('UPDATE product_variants SET stock_quantity = 500 WHERE id = $1', [
    variantId,
  ]);
  await handle.db.insert(authUsers).values({ id: USER, email: 'refund@example.test' });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
  await fake.close();
});
beforeEach(() => {
  state.role = 'admin';
  fake.reset();
  fake.requests.length = 0;
});
afterEach(() => {
  fake.reset();
});

async function place(provider: 'mono' | 'cod', quantity = 1): Promise<string> {
  seq += 1;
  const token = `tok-refund-edit-${String(seq)}`.padEnd(20, 'x');
  await handle.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId, quantity });
  });
  const view = await handle.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await handle.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: view.intentId,
        ownerToken: token,
        contact: { email: 'b@example.com', phone: '+380501112233', name: 'Buyer' },
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

async function pay(orderId: string): Promise<void> {
  await handle.pool.query(
    `INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id)
     SELECT id, 1, 'mono', total, 'succeeded', 'paid', total, $2 FROM orders WHERE id = $1`,
    [orderId, `inv-${orderId}`],
  );
  await handle.pool.query(
    "UPDATE orders SET payment_status = 'paid', captured_total = total, paid_at = now() WHERE id = $1",
    [orderId],
  );
  await handle.pool.query('UPDATE stock_reservations SET expires_at = NULL WHERE order_id = $1', [
    orderId,
  ]);
}

const cell = (rows: unknown[], key: string): unknown => {
  const row = rows[0];
  return typeof row === 'object' && row !== null
    ? Object.entries(row).find(([k]) => k === key)?.[1]
    : undefined;
};
const one = async (text: string, params: unknown[], key: string) =>
  cell((await handle.pool.query(text, params)).rows as unknown[], key);
const refundRows = async (id: string) =>
  Number(
    await one('SELECT count(*)::int AS n FROM refund_operations WHERE order_id = $1', [id], 'n'),
  );
const refundAudits = async (id: string) =>
  Number(
    await one(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'refund' AND entity_id = $1",
      [id],
      'n',
    ),
  );
const orderField = async (id: string, column: 'payment_status' | 'refunded_total' | 'total') =>
  await one(`SELECT ${column} AS v FROM orders WHERE id = $1`, [id], 'v');

describe('refund', () => {
  it('only owner and admin may refund; a manager and content are FORBIDDEN and nothing is reserved or sent', async () => {
    const id = await place('mono');
    await pay(id);
    for (const role of ['manager', 'content'] as const) {
      state.role = role;
      expect(await actions.refundOrderAction({ orderId: id, reason: 'customer asked' })).toEqual({
        ok: false,
        code: 'FORBIDDEN',
      });
    }
    expect(await refundRows(id)).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('a part refund calls the provider after commit, then the provider answer moves the status', async () => {
    const id = await place('mono');
    await pay(id);
    const result = await actions.refundOrderAction({
      orderId: id,
      amount: '100.00',
      reason: 'size did not fit',
    });
    expect(result).toEqual({ ok: true, data: { states: ['succeeded'] } });
    expect(fake.requests.filter((r) => r.url.includes('cancel'))).toHaveLength(1);
    expect(await orderField(id, 'payment_status')).toBe('partially_refunded');
    expect(Number(await orderField(id, 'refunded_total'))).toBe(10_000);
    // Two events, two rows: the admin's request (author and address) and the provider-confirmed settlement.
    expect(await refundAudits(id)).toBe(2);
    expect(
      Number(
        await one(
          "SELECT count(*)::int AS n FROM audit_log WHERE action = 'refund' AND entity_id = $1 AND user_id = $2 AND ip = '203.0.113.9'",
          [id, USER],
          'n',
        ),
      ),
    ).toBe(1);
  });

  it('refusals leave nothing behind: over budget, bad input, a cash-on-delivery order, a repeat of a full refund', async () => {
    const id = await place('mono');
    await pay(id);
    expect(
      await actions.refundOrderAction({ orderId: id, amount: '999999.00', reason: 'too much' }),
    ).toEqual({ ok: false, code: 'REFUND_BUDGET_EXCEEDED' });
    for (const input of [
      { orderId: id },
      { orderId: id, reason: 'ab' },
      { orderId: id, reason: 'x'.repeat(201) },
      { orderId: id, amount: '0', reason: 'zero' },
      { orderId: id, amount: '-5', reason: 'negative' },
      { orderId: id, amount: 'abc', reason: 'text' },
    ]) {
      expect(await actions.refundOrderAction(input)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    }
    expect(await refundRows(id)).toBe(0);
    expect(fake.requests).toHaveLength(0);

    expect((await actions.refundOrderAction({ orderId: id, reason: 'full refund' })).ok).toBe(true);
    const calls = fake.requests.length;
    expect(await actions.refundOrderAction({ orderId: id, reason: 'full refund again' })).toEqual({
      ok: false,
      code: 'REFUND_BUDGET_EXCEEDED',
    });
    expect(fake.requests).toHaveLength(calls);
    expect(await orderField(id, 'payment_status')).toBe('refunded');

    const cod = await place('cod');
    const result = await actions.refundOrderAction({ orderId: cod, reason: 'nothing was paid' });
    expect(result.ok).toBe(false);
    expect(await refundRows(cod)).toBe(0);
  });

  it('a provider that never answers leaves the refund UNKNOWN: the status is untouched and the budget stays held', async () => {
    const id = await place('mono');
    await pay(id);
    fake.onCancel(() => ({ status: 200, hang: true }));
    const result = await actions.refundOrderAction({ orderId: id, reason: 'provider is slow' });
    expect(result).toEqual({ ok: true, data: { states: ['unknown'] } });
    expect(await orderField(id, 'payment_status')).toBe('paid');
    expect(Number(await orderField(id, 'refunded_total'))).toBe(0);
    fake.reset();
    expect(await actions.refundOrderAction({ orderId: id, reason: 'try again please' })).toEqual({
      ok: false,
      code: 'REFUND_BUDGET_EXCEEDED',
    });
  });

  it('a provider refusal fails the operation and frees the budget', async () => {
    const id = await place('mono');
    await pay(id);
    fake.onCancel(() => ({ status: 400, json: { errText: 'no' } }));
    const result = await actions.refundOrderAction({ orderId: id, reason: 'provider says no' });
    expect(result).toEqual({ ok: true, data: { states: ['failed'] } });
    expect(await orderField(id, 'payment_status')).toBe('paid');
    fake.reset();
    expect((await actions.refundOrderAction({ orderId: id, reason: 'second try works' })).ok).toBe(
      true,
    );
  });
});

describe('review round 1 (#73)', () => {
  it('a double submit of a partial refund (one request id, in parallel) pays out once and calls the provider once', async () => {
    const id = await place('mono');
    await pay(id);
    const requestId = crypto.randomUUID();
    const input = { orderId: id, amount: '100.00', reason: 'size did not fit', requestId };
    const [a, b] = await Promise.all([
      actions.refundOrderAction(input),
      actions.refundOrderAction(input),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(Number(await orderField(id, 'refunded_total'))).toBe(10_000);
    expect(await refundRows(id)).toBe(1);
    expect(fake.requests.filter((r) => r.url.includes('cancel'))).toHaveLength(1);
  });

  it('a forged userId in the input is ignored: the author is the session', async () => {
    const id = await place('mono');
    await pay(id);
    await actions.refundOrderAction({
      orderId: id,
      amount: '10.00',
      reason: 'forged author',
      userId: '11111111-1111-4111-8111-111111111111',
      initiatedBy: '11111111-1111-4111-8111-111111111111',
    });
    expect(
      await one(
        'SELECT initiated_by_user_id::text AS v FROM refund_operations WHERE order_id = $1',
        [id],
        'v',
      ),
    ).toBe(USER);
  });

  it('an unpaid online order with an open payment cannot be edited (typed code)', async () => {
    const id = await place('mono', 2);
    await handle.pool.query(
      "INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status) SELECT id, 1, 'mono', total, 'in_flight', 'pending' FROM orders WHERE id = $1",
      [id],
    );
    const itemId = String(
      await one('SELECT id AS v FROM order_items WHERE order_id = $1', [id], 'v'),
    );
    expect(
      await actions.editOrderItemsAction({
        orderId: id,
        reason: 'customer asked',
        changes: [{ itemId, quantity: 1 }],
      }),
    ).toEqual({ ok: false, code: 'ORDER_PAYMENT_OPEN' });
  });
});

describe('withdraw and resolve a refund by hand', () => {
  /** A refund operation in the given state on a paid order, made through the real action first. */
  async function operation(state: 'pending' | 'in_flight' | 'unknown') {
    const id = await place('mono');
    await pay(id);
    fake.onCancel(() => ({ status: 200, hang: true }));
    await actions.refundOrderAction({ orderId: id, amount: '100.00', reason: 'setup refund' });
    fake.reset();
    const opId = String(
      await one('SELECT id AS v FROM refund_operations WHERE order_id = $1', [id], 'v'),
    );
    await handle.pool.query(
      'UPDATE refund_operations SET state = $2::operation_state WHERE id = $1',
      [opId, state],
    );
    return { id, opId };
  }
  const opState = async (opId: string) =>
    await one('SELECT state AS v FROM refund_operations WHERE id = $1', [opId], 'v');

  it('only owner and admin: a manager and content are FORBIDDEN on both and nothing changes', async () => {
    const { opId } = await operation('unknown');
    for (const role of ['manager', 'content'] as const) {
      state.role = role;
      expect(await actions.withdrawRefundAction({ operationId: opId })).toEqual({
        ok: false,
        code: 'FORBIDDEN',
      });
      expect(
        await actions.resolveRefundAction({
          operationId: opId,
          outcome: 'succeeded',
          note: 'portal says so',
        }),
      ).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    expect(await opState(opId)).toBe('unknown');
  });

  it('withdraw frees a pending refund; one that was sent cannot be withdrawn', async () => {
    const pending = await operation('pending');
    expect(await actions.withdrawRefundAction({ operationId: pending.opId })).toEqual({
      ok: true,
      data: { changed: true },
    });
    expect(await opState(pending.opId)).toBe('failed');
    expect(await actions.withdrawRefundAction({ operationId: pending.opId })).toEqual({
      ok: true,
      data: { changed: false },
    });
    const sent = await operation('in_flight');
    expect(await actions.withdrawRefundAction({ operationId: sent.opId })).toEqual({
      ok: true,
      data: { changed: false },
    });
    expect(await opState(sent.opId)).toBe('in_flight');
    expect(
      await actions.withdrawRefundAction({ operationId: '00000000-0000-4000-8000-00000000dead' }),
    ).toEqual({ ok: false, code: 'REFUND_NOT_ALLOWED' });
  });

  it('resolve as returned settles the order once; a repeat is a no-op with no second audit row', async () => {
    const { id, opId } = await operation('unknown');
    const input = { operationId: opId, outcome: 'succeeded', note: 'portal, 26 Nov' };
    expect(await actions.resolveRefundAction(input)).toMatchObject({
      ok: true,
      data: { changed: true, state: 'succeeded' },
    });
    expect(Number(await orderField(id, 'refunded_total'))).toBe(10_000);
    expect(await orderField(id, 'payment_status')).toBe('partially_refunded');
    const audits = await refundAudits(id);
    expect(await actions.resolveRefundAction(input)).toMatchObject({
      ok: true,
      data: { changed: false },
    });
    expect(await refundAudits(id)).toBe(audits);
    expect(Number(await orderField(id, 'refunded_total'))).toBe(10_000);
  });

  it('resolve as NOT returned fails the operation and frees the budget; a pending one cannot be resolved', async () => {
    const { id, opId } = await operation('in_flight');
    expect(
      await actions.resolveRefundAction({
        operationId: opId,
        outcome: 'failed',
        note: 'portal, no such refund',
      }),
    ).toMatchObject({ ok: true, data: { state: 'failed' } });
    expect(Number(await orderField(id, 'refunded_total'))).toBe(0);
    expect((await actions.refundOrderAction({ orderId: id, reason: 'again after check' })).ok).toBe(
      true,
    );
    const pending = await operation('pending');
    expect(
      await actions.resolveRefundAction({
        operationId: pending.opId,
        outcome: 'succeeded',
        note: 'not sent yet',
      }),
    ).toEqual({ ok: false, code: 'REFUND_NOT_ALLOWED' });
    for (const bad of [
      { operationId: opId },
      { operationId: opId, outcome: 'maybe', note: 'portal' },
      { operationId: opId, outcome: 'failed', note: 'a' },
    ]) {
      expect(await actions.resolveRefundAction(bad)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    }
  });
});

describe('edit items through the chain', () => {
  const itemOf = async (id: string) =>
    String(await one('SELECT id AS v FROM order_items WHERE order_id = $1', [id], 'v'));

  it('content is FORBIDDEN; a manager edits with one audit row carrying author, address and the total change', async () => {
    const id = await place('mono', 3);
    const itemId = await itemOf(id);
    state.role = 'content';
    expect(
      await actions.editOrderItemsAction({
        orderId: id,
        reason: 'customer asked',
        changes: [{ itemId, quantity: 1 }],
      }),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    state.role = 'manager';
    const before = Number(await orderField(id, 'total'));
    expect(
      await actions.editOrderItemsAction({
        orderId: id,
        reason: 'customer asked',
        changes: [{ itemId, quantity: 1 }],
      }),
    ).toEqual({ ok: true, data: { changed: true, refundDue: 0 } });
    expect(Number(await orderField(id, 'total'))).toBe(before - 2 * 129_900);
    const diff = JSON.stringify(
      await one(
        "SELECT diff AS d FROM audit_log WHERE action = 'update' AND entity = 'order_items' AND entity_id = $1",
        [id],
        'd',
      ),
    );
    expect(diff).toContain(String(before));
    expect(
      await one(
        "SELECT ip AS v FROM audit_log WHERE entity = 'order_items' AND entity_id = $1",
        [id],
        'v',
      ),
    ).toBe('203.0.113.9');
    // A repeat changes nothing and writes no second audit row.
    expect(
      (
        await actions.editOrderItemsAction({
          orderId: id,
          reason: 'customer asked',
          changes: [{ itemId, quantity: 1 }],
        })
      ).ok,
    ).toBe(true);
    expect(
      Number(
        await one(
          "SELECT count(*)::int AS n FROM audit_log WHERE entity = 'order_items' AND entity_id = $1",
          [id],
          'n',
        ),
      ),
    ).toBe(1);
  });

  it('invalid input and refusals change nothing', async () => {
    const id = await place('mono', 2);
    const itemId = await itemOf(id);
    for (const input of [
      { orderId: id, changes: [{ itemId, quantity: 1 }] },
      { orderId: id, reason: 'ok reason', changes: [] },
      { orderId: id, reason: 'ok reason', changes: [{ itemId, quantity: -1 }] },
      { orderId: id, reason: 'ok reason', changes: [{ itemId, quantity: 1.5 }] },
      { orderId: id, reason: 'ok reason', changes: [{ itemId: 'nope', quantity: 1 }] },
    ]) {
      expect(await actions.editOrderItemsAction(input)).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
    }
    expect(
      await actions.editOrderItemsAction({
        orderId: id,
        reason: 'remove it all',
        changes: [{ itemId, quantity: 0 }],
      }),
    ).toEqual({ ok: false, code: 'ORDER_TRANSITION_INVALID' });
    expect(
      Number(await one('SELECT quantity AS v FROM order_items WHERE id = $1', [itemId], 'v')),
    ).toBe(2);
  });

  it('a paid order made cheaper reports the surplus for the refund flow', async () => {
    const id = await place('mono', 2);
    await pay(id);
    const itemId = await itemOf(id);
    expect(
      await actions.editOrderItemsAction({
        orderId: id,
        reason: 'customer dropped one',
        changes: [{ itemId, quantity: 1 }],
      }),
    ).toEqual({ ok: true, data: { changed: true, refundDue: 129_900 } });
  });
});
