/**
 * The real order action chain against Postgres: action -> `createAdminAction` (Origin, session,
 * role, limit, validation, ONE transaction, audit) -> the domain function. Only the request-bound
 * inputs (session, Origin) are supplied by the test.
 */
import { money, toHryvniasText } from '@store/shared/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { createOrder } from '@store/core/orders';
import { setCartItem, startCheckout } from '@store/core/cart';
import { authUsers, settings } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const USER = '00000000-0000-4000-8000-0000000000aa';
const state: { role: AdminSession['role']; handle: Db | null } = vi.hoisted(() => ({
  role: 'manager',
  handle: null,
}));

async function wired() {
  const { createAdminAction: create } = await import('../src/lib/admin/action');
  const { createRateLimiter: limiter } = await import('../src/lib/rate-limit');
  return {
    adminAction: create({
      originOk: () => Promise.resolve(true),
      session: () =>
        Promise.resolve({
          kind: 'full',
          session: { sid: 's', userId: USER, email: 'orders@example.test', role: state.role },
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
// The module imports these through the web app's `@/` alias; the chain under test never calls them.
vi.mock('@/lib/db', () => ({ getDb: () => Promise.reject(new Error('not used here')) }));
vi.mock('@/lib/waybill-carrier', () => ({ getWaybillCarrier: () => Promise.resolve(null) }));
vi.mock('@/lib/payment-providers', () => ({ getPaymentProviders: () => Promise.resolve({}) }));

const actions = await import('../src/actions/admin-orders');

let testDb: TestDatabase;
let handle: DbHandle;
let variantId: string;
let seq = 0;

beforeAll(async () => {
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
  await handle.db.insert(authUsers).values({ id: USER, email: 'orders@example.test' });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});
beforeEach(() => {
  state.role = 'manager';
});

async function place(provider: 'mono' | 'cod' | 'bank_transfer' = 'mono'): Promise<string> {
  seq += 1;
  const token = `tok-orders-action-${String(seq)}`.padEnd(20, 'x');
  await handle.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId, quantity: 1 });
  });
  // One unit of stock per variant in the skeleton: top it up so every test can place an order.
  await handle.pool.query('UPDATE product_variants SET stock_quantity = 50 WHERE id = $1', [
    variantId,
  ]);
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

async function markPaid(orderId: string): Promise<void> {
  await handle.pool.query(
    "UPDATE orders SET payment_status = 'paid', captured_total = total, paid_at = now() WHERE id = $1",
    [orderId],
  );
  await handle.pool.query('UPDATE stock_reservations SET expires_at = NULL WHERE order_id = $1', [
    orderId,
  ]);
}

const q = async (text: string, params: unknown[]) =>
  (await handle.pool.query(text, params)).rows as unknown[];
const cell = (row: unknown, key: string): unknown =>
  typeof row === 'object' && row !== null
    ? Object.entries(row).find(([k]) => k === key)?.[1]
    : undefined;
const statusOf = async (id: string) =>
  cell((await q('SELECT status FROM orders WHERE id = $1', [id]))[0], 'status');
const audits = async (id: string) =>
  await q(
    "SELECT user_id, ip, diff FROM audit_log WHERE entity = 'order' AND action = 'transition' AND entity_id = $1",
    [id],
  );
const histories = async (id: string) =>
  Number(
    cell(
      (await q('SELECT count(*)::int AS n FROM order_status_history WHERE order_id = $1', [id]))[0],
      'n',
    ),
  );

describe('role matrix', () => {
  it('content is FORBIDDEN on every order action and nothing changes', async () => {
    const id = await place();
    await markPaid(id);
    const histBefore = await histories(id);
    state.role = 'content';
    const calls = [
      actions.confirmOrderAction({ orderId: id }),
      actions.processOrderAction({ orderId: id }),
      actions.shipOrderAction({ orderId: id }),
      actions.deliverOrderAction({ orderId: id }),
      actions.cancelOrderAction({ orderId: id, reason: 'no reason at all' }),
      actions.addOrderNoteAction({ orderId: id, text: 'hello' }),
      actions.confirmTransferAction({ orderId: id, bankReference: 'R1', amount: '1299.00' }),
    ];
    for (const result of await Promise.all(calls)) {
      expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    expect(await statusOf(id)).toBe('pending');
    expect(await histories(id)).toBe(histBefore);
    expect(await audits(id)).toHaveLength(0);
  });

  it.each(['owner', 'admin', 'manager'] as const)(
    '%s may confirm, with author and address audited',
    async (role) => {
      state.role = role;
      const id = await place();
      await markPaid(id);
      expect((await actions.confirmOrderAction({ orderId: id })).ok).toBe(true);
      expect(await statusOf(id)).toBe('confirmed');
      const rows = await audits(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: USER, ip: '203.0.113.9' });
    },
  );
});

describe('review round 1', () => {
  it('ship needs a confirmed order and audits the real previous status', async () => {
    const id = await place();
    await markPaid(id);
    expect(await actions.shipOrderAction({ orderId: id })).toEqual({
      ok: false,
      code: 'ORDER_NOT_SHIPPABLE',
    });
    expect((await actions.confirmOrderAction({ orderId: id })).ok).toBe(true);
    expect((await actions.processOrderAction({ orderId: id })).ok).toBe(true);
    expect((await actions.shipOrderAction({ orderId: id })).ok).toBe(true);
    const diffs = JSON.stringify(await audits(id));
    expect(diffs).toContain('"from":"processing"');
    expect(diffs).not.toContain('open');
  });

  it('cancelling a paid order tells the person that money is owed', async () => {
    const id = await place();
    await markPaid(id);
    const result = await actions.cancelOrderAction({ orderId: id, reason: 'customer called' });
    expect(result).toMatchObject({ ok: true, data: { changed: true, heldAuthorization: false } });
    expect(result.ok && 'refundDue' in result.data ? result.data.refundDue : 0).toBeGreaterThan(0);
  });

  it('a transfer that also confirms the order audits both changes', async () => {
    const id = await place('bank_transfer');
    const total = Number(
      cell((await q('SELECT total FROM orders WHERE id = $1', [id]))[0], 'total'),
    );
    expect(
      (
        await actions.confirmTransferAction({
          orderId: id,
          bankReference: 'BANK-AUDIT',
          amount: toHryvniasText(money(total)),
        })
      ).ok,
    ).toBe(true);
    const diffs = JSON.stringify(await audits(id));
    expect(diffs).toContain('"payment_status"');
    expect(diffs).toContain('"to":"confirmed"');
  });
});

describe('validation, replay, refusal', () => {
  it('a cancellation without a reason (or a blank one) is INVALID_INPUT and changes nothing', async () => {
    const id = await place();
    for (const reason of [undefined, '', '   ', 'ab', 'x'.repeat(501), 'a\u0000bc']) {
      expect(await actions.cancelOrderAction({ orderId: id, reason })).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
    }
    expect(await statusOf(id)).toBe('pending');
    expect(await actions.confirmOrderAction({ orderId: 'not-a-uuid' })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });

  it('cancel releases the reservation, keeps stock_quantity, and a repeat writes no second audit row', async () => {
    const id = await place();
    const before = (
      await q(
        'SELECT stock_quantity AS s, reserved_quantity AS r FROM product_variants WHERE id = $1',
        [variantId],
      )
    )[0];
    const input = { orderId: id, reason: 'customer called' };
    expect((await actions.cancelOrderAction(input)).ok).toBe(true);
    expect((await actions.cancelOrderAction(input)).ok).toBe(true);
    const after = (
      await q(
        'SELECT stock_quantity AS s, reserved_quantity AS r FROM product_variants WHERE id = $1',
        [variantId],
      )
    )[0];
    expect(cell(after, 's')).toBe(cell(before, 's'));
    expect(Number(cell(after, 'r'))).toBe(Number(cell(before, 'r')) - 1);
    expect(await audits(id)).toHaveLength(1);
    expect(
      await q(
        "SELECT comment FROM order_status_history WHERE order_id = $1 AND to_status = 'cancelled'",
        [id],
      ),
    ).toEqual([{ comment: 'customer called' }]);
  });

  it('a refused ship (unpaid) is a typed code and rolls everything back', async () => {
    const id = await place();
    const histBefore = await histories(id);
    expect(await actions.shipOrderAction({ orderId: id })).toEqual({
      ok: false,
      code: 'ORDER_NOT_SHIPPABLE',
    });
    expect(await statusOf(id)).toBe('pending');
    expect(await histories(id)).toBe(histBefore);
    expect(await audits(id)).toHaveLength(0);
  });

  it('a transfer: wrong amount is refused, the right one is paid once, a repeat is a no-op', async () => {
    const id = await place('bank_transfer');
    const total = Number(
      cell((await q('SELECT total FROM orders WHERE id = $1', [id]))[0], 'total'),
    );
    expect(
      await actions.confirmTransferAction({ orderId: id, bankReference: 'BANK-1', amount: '1.00' }),
    ).toEqual({ ok: false, code: 'TRANSFER_AMOUNT_MISMATCH' });
    const ok = { orderId: id, bankReference: 'BANK-1', amount: toHryvniasText(money(total)) };
    expect((await actions.confirmTransferAction(ok)).ok).toBe(true);
    expect((await actions.confirmTransferAction(ok)).ok).toBe(true);
    expect(await audits(id)).toHaveLength(1);
    expect(
      (await q('SELECT payment_status, captured_total FROM orders WHERE id = $1', [id]))[0],
    ).toEqual({
      payment_status: 'paid',
      captured_total: total,
    });
  });

  it('a note keeps its text out of the audit row but in the history, with the author', async () => {
    const id = await place();
    expect((await actions.addOrderNoteAction({ orderId: id, text: 'call after 5pm' })).ok).toBe(
      true,
    );
    const audit = JSON.stringify(await q('SELECT diff FROM audit_log WHERE entity_id = $1', [id]));
    expect(audit).not.toContain('call after');
    expect(
      (
        await q(
          "SELECT changed_by_user_id::text AS by FROM order_status_history WHERE order_id = $1 AND field = 'note'",
          [id],
        )
      )[0],
    ).toEqual({ by: USER });
  });
});
