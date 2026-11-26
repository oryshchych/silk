/**
 * Admin orders on real Postgres with separate connections: the workflow (phase 5, slice 1), ADR-18
 * stock semantics through the admin path, rollback, the list at 10 000 orders, and what the card
 * serialises per role.
 */
import { sql } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import { AdminNotFoundError } from '../src/catalog-admin/errors.ts';
import {
  OrderNotConfirmableError,
  OrderNotCancellableError,
  OrderNotShippableError,
  OrderTransitionError,
} from '../src/errors.ts';
import { cancelOrder, shipOrder } from '../src/orders/fulfilment.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { getAdminOrder, listAdminOrders, ORDERS_PAGE_SIZE } from '../src/orders-admin/read.ts';
import { addOrderNote, advanceOrder } from '../src/orders-admin/workflow.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const USER = '00000000-0000-4000-8000-0000000000aa';

let world: TestWorld;
let admin: DbHandle;
let v1: string;
let seq = 0;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  [v1] = world.fixture.variantIds;
});
afterEach(async () => {
  await world.close();
});

async function place(provider: 'mono' | 'cod' | 'bank_transfer' = 'mono'): Promise<string> {
  seq += 1;
  const token = `tok-orders-admin-${String(seq)}`.padEnd(20, 'x');
  await admin.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId: v1, quantity: 1 });
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
        paymentProvider: provider,
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  return placed.orderId;
}

/** Test setup only: the webhook flow that really does this is covered in webhook.int.test.ts. */
async function markPaid(orderId: string): Promise<void> {
  await admin.db.execute(
    sql`UPDATE orders SET payment_status = 'paid', captured_total = total, paid_at = now()
         WHERE id = ${orderId}`,
  );
  await admin.db.execute(
    sql`UPDATE stock_reservations SET expires_at = NULL WHERE order_id = ${orderId}`,
  );
}

const step = async (orderId: string, to: 'confirmed' | 'processing' | 'delivered', h = admin) =>
  await h.db.transaction(async (tx) => await advanceOrder(tx, { orderId, to, actorUserId: USER }));

async function one<T extends QueryResultRow>(query: ReturnType<typeof sql>) {
  const result = await admin.db.execute<T>(query);
  const row = result.rows[0];
  if (row === undefined) throw new Error('no row');
  return row;
}
const stock = async () =>
  await one<{ stock: number; reserved: number }>(
    sql`SELECT stock_quantity AS stock, reserved_quantity AS reserved FROM product_variants WHERE id = ${v1}`,
  );
const historyCount = async (orderId: string, where = sql`true`) =>
  (
    await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM order_status_history WHERE order_id = ${orderId} AND ${where}`,
    )
  ).n;
const transitionAudits = async () =>
  (
    await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'transition'`,
    )
  ).n;

describe('the one-step workflow', () => {
  it('walks a paid card order to delivered; stock moves only at ship (ADR-18)', async () => {
    const orderId = await place();
    await markPaid(orderId);
    expect(await step(orderId, 'confirmed')).toMatchObject({ changed: true, to: 'confirmed' });
    expect(await step(orderId, 'processing')).toMatchObject({ changed: true });
    expect(await stock()).toEqual({ stock: 1, reserved: 1 });
    await admin.db.transaction(
      async (tx) =>
        await shipOrder(tx, {
          orderId,
          source: 'admin',
          actorUserId: USER,
          auditByCaller: true,
        }),
    );
    expect(await stock()).toEqual({ stock: 0, reserved: 0 });
    expect(await step(orderId, 'delivered')).toMatchObject({ changed: true });
    const row = await one<{ status: string; delivered: boolean }>(
      sql`SELECT status, delivered_at IS NOT NULL AS delivered FROM orders WHERE id = ${orderId}`,
    );
    expect(row).toEqual({ status: 'delivered', delivered: true });
    // Every step has a history row with its author; none wrote an audit row (the caller does).
    expect(await historyCount(orderId, sql`changed_by_user_id = ${USER}`)).toBe(4);
    expect(await transitionAudits()).toBe(0);
  });

  it('refuses a step the state does not allow, and an unpaid card order cannot be confirmed', async () => {
    const orderId = await place();
    await expect(step(orderId, 'confirmed')).rejects.toBeInstanceOf(OrderNotConfirmableError);
    await expect(step(orderId, 'processing')).rejects.toBeInstanceOf(OrderTransitionError);
    await expect(step(orderId, 'delivered')).rejects.toBeInstanceOf(OrderTransitionError);
    await markPaid(orderId);
    await step(orderId, 'confirmed');
    await admin.db.transaction(
      async (tx) =>
        await cancelOrder(tx, { orderId, source: 'admin', reason: 'test', actorUserId: USER }),
    );
    await expect(step(orderId, 'processing')).rejects.toBeInstanceOf(OrderTransitionError);
    await expect(step(orderId, 'confirmed')).rejects.toBeInstanceOf(OrderTransitionError);
  });

  it('is a no-op when repeated: one history row, nothing else written', async () => {
    const orderId = await place();
    await markPaid(orderId);
    expect(await step(orderId, 'confirmed')).toMatchObject({ changed: true });
    const before = await historyCount(orderId);
    expect(await step(orderId, 'confirmed')).toMatchObject({ changed: false });
    expect(await historyCount(orderId)).toBe(before);
  });

  it('confirms a COD order, lifting the reservation expiry', async () => {
    const orderId = await place('cod');
    expect(await step(orderId, 'confirmed')).toMatchObject({ changed: true });
    const live = await one<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM stock_reservations WHERE order_id = ${orderId} AND expires_at IS NULL AND released_at IS NULL`,
    );
    expect(live.n).toBe(1);
  });

  it('a rolled-back transaction leaves the order exactly as it was', async () => {
    const orderId = await place();
    await markPaid(orderId);
    await expect(
      admin.db.transaction(async (tx) => {
        await advanceOrder(tx, { orderId, to: 'confirmed', actorUserId: USER });
        throw new Error('the caller failed after the step');
      }),
    ).rejects.toThrow('the caller failed');
    expect(
      (await one<{ status: string }>(sql`SELECT status FROM orders WHERE id = ${orderId}`)).status,
    ).toBe('pending');
    expect(await historyCount(orderId, sql`to_status = 'confirmed'`)).toBe(0);
  });

  it('two managers pressing Confirm at once write ONE history row (separate connections)', async () => {
    const orderId = await place();
    await markPaid(orderId);
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      return await handle.db.transaction(async (tx) => {
        await barrier.wait();
        return await advanceOrder(tx, { orderId, to: 'confirmed', actorUserId: USER });
      });
    };
    const results = await Promise.all([run(), run()]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await historyCount(orderId, sql`to_status = 'confirmed'`)).toBe(1);
  });
});

describe('cancel and ship race (ADR-18)', () => {
  it('cancel never changes stock_quantity; it only releases the reservation', async () => {
    const orderId = await place();
    await markPaid(orderId);
    await admin.db.transaction(
      async (tx) =>
        await cancelOrder(tx, {
          orderId,
          source: 'admin',
          reason: 'customer called',
          actorUserId: USER,
          auditByCaller: true,
        }),
    );
    expect(await stock()).toEqual({ stock: 1, reserved: 0 });
    const history = await one<{ comment: string; by: string }>(
      sql`SELECT comment, changed_by_user_id::text AS by FROM order_status_history WHERE order_id = ${orderId} AND to_status = 'cancelled'`,
    );
    expect(history).toEqual({ comment: 'customer called', by: USER });
    await expect(
      admin.db.transaction(
        async (tx) =>
          await cancelOrder(tx, { orderId: await place('cod'), source: 'admin', reason: 'x' }),
      ),
    ).resolves.toMatchObject({ changed: true });
  });

  it('cancel and ship pressed together: exactly one wins and the stock invariant holds', async () => {
    const orderId = await place();
    await markPaid(orderId);
    await step(orderId, 'confirmed');
    const barrier = new Barrier(2);
    const settle = async (op: 'ship' | 'cancel') => {
      const handle = world.connect();
      try {
        return await handle.db.transaction(async (tx) => {
          await barrier.wait();
          return op === 'ship'
            ? await shipOrder(tx, { orderId, source: 'admin', actorUserId: USER })
            : await cancelOrder(tx, {
                orderId,
                source: 'admin',
                reason: 'race',
                actorUserId: USER,
              });
        });
      } catch (error) {
        return error;
      }
    };
    const [shipped, cancelled] = await Promise.all([settle('ship'), settle('cancel')]);
    const wins = [shipped, cancelled].filter((r) => !(r instanceof Error));
    expect(wins).toHaveLength(1);
    const losers = [shipped, cancelled].filter((r) => r instanceof Error);
    expect(
      losers[0] instanceof OrderNotCancellableError || losers[0] instanceof OrderNotShippableError,
    ).toBe(true);
    const row = await one<{ status: string }>(sql`SELECT status FROM orders WHERE id = ${orderId}`);
    const state = await stock();
    if (row.status === 'shipped') expect(state).toEqual({ stock: 0, reserved: 0 });
    else expect(state).toEqual({ stock: 1, reserved: 0 });
    const drift = await admin.db.execute(
      sql`SELECT v.id FROM product_variants v WHERE v.reserved_quantity <> coalesce(
            (SELECT sum(r.quantity) FROM stock_reservations r WHERE r.variant_id = v.id AND r.released_at IS NULL), 0)`,
    );
    expect(drift.rows).toEqual([]);
  });
});

describe('internal notes', () => {
  it('appends a note with its author and never touches the status', async () => {
    const orderId = await place();
    await admin.db.transaction(
      async (tx) => await addOrderNote(tx, { orderId, text: 'call after 5pm', actorUserId: USER }),
    );
    const note = await one<{ comment: string; by: string; field: string }>(
      sql`SELECT comment, changed_by_user_id::text AS by, field FROM order_status_history WHERE order_id = ${orderId} AND field = 'note'`,
    );
    expect(note).toEqual({ comment: 'call after 5pm', by: USER, field: 'note' });
    expect(
      (await one<{ status: string }>(sql`SELECT status FROM orders WHERE id = ${orderId}`)).status,
    ).toBe('pending');
  });

  it('refuses an unknown order', async () => {
    await expect(
      admin.db.transaction(
        async (tx) =>
          await addOrderNote(tx, {
            orderId: '00000000-0000-4000-8000-00000000dead',
            text: 'x',
            actorUserId: USER,
          }),
      ),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
  });
});

/** Bulk-inserts `count` orders with one item each: the shape of a busy shop's table. */
async function bulkOrders(count: number): Promise<void> {
  await admin.db.execute(sql`
    INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method,
                        subtotal, total, status, payment_status, payment_provider, ttn, created_at)
    SELECT 'LS-2026-' || lpad(i::text, 6, '0'),
           'buyer' || i || '@example.com',
           '+3805011' || lpad((i % 100000)::text, 5, '0'),
           'Buyer ' || i,
           'np_warehouse',
           129900, 129900,
           (ARRAY['pending','confirmed','shipped','delivered','cancelled'])[1 + i % 5]::order_status,
           (ARRAY['pending','paid'])[1 + i % 2]::payment_status,
           (ARRAY['mono','cod'])[1 + i % 2]::payment_provider,
           CASE WHEN i % 5 = 2 THEN '5900' || lpad(i::text, 10, '0') END,
           now() - (i || ' minutes')::interval
      FROM generate_series(1, ${count}) AS i`);
  await admin.db.execute(sql`
    INSERT INTO order_items (order_id, product_uid_snapshot, variant_uid_snapshot, name_snapshot,
                             sku_snapshot, size_label, color_name, unit_price, quantity, line_total)
    SELECT id, gen_random_uuid(), gen_random_uuid(), 'Bra', 'SK-001', 'S', 'Black', 129900, 2, 259800
      FROM orders`);
}

describe('the list', () => {
  it('opens a page of 10 000 orders in under 500 ms, cold and with a filter and a search', async () => {
    await bulkOrders(10_000);
    const timed = async (filters: Parameters<typeof listAdminOrders>[1]) => {
      const started = performance.now();
      const page = await listAdminOrders(admin.db, filters);
      return { page, ms: performance.now() - started };
    };
    const plain = await timed({});
    expect(plain.page.total).toBe(10_000);
    expect(plain.page.items).toHaveLength(ORDERS_PAGE_SIZE);
    expect(plain.page.items[0]?.itemCount).toBe(2);
    expect(plain.ms).toBeLessThan(500);
    for (const filters of [
      { status: 'shipped' as const },
      { q: 'LS-2026-00' },
      { q: 'buyer77@' },
      { q: '0501100077' },
      { q: 'Buyer 123' },
      { page: 200 },
    ]) {
      expect((await timed(filters)).ms, JSON.stringify(filters)).toBeLessThan(500);
    }
  });

  it('finds an order by number, phone in any spelling, email, waybill and name', async () => {
    await bulkOrders(50);
    const find = async (q: string) =>
      (await listAdminOrders(admin.db, { q })).items.map((row) => row.orderNumber);
    expect(await find('LS-2026-000007')).toEqual(['LS-2026-000007']);
    expect(await find('ls-2026-000007')).toEqual(['LS-2026-000007']);
    expect(await find('+380501100007')).toEqual(['LS-2026-000007']);
    expect(await find('050 110 0007')).toEqual(['LS-2026-000007']);
    expect(await find('buyer7@example.com')).toEqual(['LS-2026-000007']);
    expect(await find('59000000000007')).toEqual(['LS-2026-000007']);
    expect(await find('Buyer 7')).toContain('LS-2026-000007');
    expect(await find('no-such-buyer')).toEqual([]);
  });

  it('treats %, _, a backslash and a NUL byte as plain text and filters by status and day', async () => {
    await bulkOrders(20);
    for (const q of ['%', '_', '\\', 'a\u0000b', "'; DROP TABLE orders; --"]) {
      expect((await listAdminOrders(admin.db, { q })).items).toEqual([]);
    }
    const shipped = await listAdminOrders(admin.db, { status: 'shipped', paymentStatus: 'paid' });
    expect(
      shipped.items.every((row) => row.status === 'shipped' && row.paymentStatus === 'paid'),
    ).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect((await listAdminOrders(admin.db, { from: today, to: today })).total).toBe(20);
    expect((await listAdminOrders(admin.db, { from: '2001-01-01', to: '2001-01-02' })).total).toBe(
      0,
    );
    // A garbled date is ignored, not a 500.
    expect((await listAdminOrders(admin.db, { from: 'yesterday' })).total).toBe(20);
    expect((await listAdminOrders(admin.db, { page: 9_999 })).items).toEqual([]);
  });
});

describe('the card, serialised per role', () => {
  async function seedSecrets(orderId: string): Promise<void> {
    await admin.db.execute(
      sql`UPDATE orders SET ip = '198.51.100.7', user_agent = 'SecretAgent/1', access_token_hash = 'deadbeefhash',
                            shipping_cost_actual = 4242 WHERE id = ${orderId}`,
    );
    await admin.db.execute(
      sql`UPDATE order_items SET unit_cost_snapshot = 777700 WHERE order_id = ${orderId}`,
    );
    await admin.db.execute(
      sql`INSERT INTO payment_events (order_id, provider, message_key, event_type, raw_payload, applied_at)
          VALUES (${orderId}, 'mono', 'msg-1', 'payment.paid', '{"pan":"SECRETPAN4111"}'::jsonb, now())`,
    );
  }

  it('a role without the cost permission gets no cost key and no secret, in the JSON itself', async () => {
    const orderId = await place();
    await seedSecrets(orderId);
    const json = JSON.stringify(await getAdminOrder(admin.db, orderId, false));
    for (const leak of [
      'unitCostSnapshot',
      '777700',
      'shippingCostActual',
      '4242',
      'accessTokenHash',
      'deadbeefhash',
      '198.51.100.7',
      'SecretAgent',
      'rawPayload',
      'SECRETPAN',
      'userAgent',
    ]) {
      expect(json, leak).not.toContain(leak);
    }
    expect(json).toContain('payment.paid');
  });

  it('a role with the cost permission gets the cost, and still no secret', async () => {
    const orderId = await place();
    await seedSecrets(orderId);
    const json = JSON.stringify(await getAdminOrder(admin.db, orderId, true));
    expect(json).toContain('"unitCostSnapshot":777700');
    expect(json).toContain('"shippingCostActual":4242');
    for (const leak of ['deadbeefhash', '198.51.100.7', 'SecretAgent', 'SECRETPAN']) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it('returns null for an unknown order', async () => {
    expect(await getAdminOrder(admin.db, '00000000-0000-4000-8000-00000000dead', false)).toBeNull();
  });
});
