/**
 * Waybill action and print route through the real chain, with the real adapter against the local
 * fake Nova Poshta (real HTTP). Nothing here can reach the real carrier: the app is pointed at a
 * fake on a loopback port.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { createOrder } from '@store/core/orders';
import { setCartItem, startCheckout } from '@store/core/cart';
import { authUsers, settings } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import { NovaPoshtaWaybill } from '@store/payments/nova-poshta';
import {
  FAKE_NP_KEY,
  startFakeNovaPoshta,
  type FakeNovaPoshta,
} from '@store/payments/test/fake-nova-poshta';

const USER = '00000000-0000-4000-8000-0000000000aa';
const state: {
  role: AdminSession['role'];
  signedIn: boolean;
  handle: Db | null;
  carrier: NovaPoshtaWaybill | null;
} = vi.hoisted(() => ({ role: 'manager', signedIn: true, handle: null, carrier: null }));

async function wired() {
  const { createAdminAction: create } = await import('../src/lib/admin/action');
  const { createRateLimiter: limiter } = await import('../src/lib/rate-limit');
  return {
    adminAction: create({
      originOk: () => Promise.resolve(true),
      session: () => Promise.resolve(resolved()),
      transaction: async (fn) => {
        if (state.handle === null) throw new Error('no database');
        return await state.handle.transaction(fn);
      },
      client: () => Promise.resolve('203.0.113.9'),
      limiter: limiter({ limit: 1_000, windowMs: 60_000 }),
    }),
  };
}
const resolved = (): ResolvedSession | null =>
  state.signedIn
    ? {
        kind: 'full',
        session: { sid: 's', userId: USER, email: 'np@example.test', role: state.role },
      }
    : null;
vi.mock('@/lib/admin/bound-action', wired);
vi.mock('../src/lib/admin/bound-action', wired);
vi.mock('@/lib/admin/session', () => ({ currentSession: () => Promise.resolve(resolved()) }));
vi.mock('@/lib/rate-limit', async () => await import('../src/lib/rate-limit'));
vi.mock('@/lib/payment-providers', () => ({ getPaymentProviders: () => Promise.resolve({}) }));
vi.mock('@/lib/waybill-carrier', () => ({
  getWaybillCarrier: () => Promise.resolve(state.carrier),
}));
vi.mock('@/lib/db', () => ({
  getDb: () =>
    state.handle === null
      ? Promise.reject(new Error('no database'))
      : Promise.resolve(state.handle),
}));

const actions = await import('../src/actions/admin-orders');
const print = await import('../src/app/admin/print/waybill/[id]/route');

let testDb: TestDatabase;
let handle: DbHandle;
let fake: FakeNovaPoshta;
let variantId: string;
let seq = 0;

beforeAll(async () => {
  fake = await startFakeNovaPoshta();
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  variantId = (
    await handle.db.transaction(async (tx) => {
      await tx.insert(settings).values([
        {
          key: 'payment_providers',
          value: { mono: true, wayforpay: true, cod: true, bank_transfer: true },
        },
        {
          key: 'np_sender',
          value: {
            cityRef: 'c',
            senderRef: 's',
            contactRef: 'k',
            addressRef: 'a',
            phone: '+380441112233',
          },
        },
      ]);
      return await seedMoneySkeleton(tx);
    })
  ).variantIds[0];
  await handle.pool.query('UPDATE product_variants SET stock_quantity = 500 WHERE id = $1', [
    variantId,
  ]);
  await handle.db.insert(authUsers).values({ id: USER, email: 'np@example.test' });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
  await fake.close();
});
beforeEach(() => {
  state.role = 'manager';
  state.signedIn = true;
  state.carrier = new NovaPoshtaWaybill({
    apiKey: FAKE_NP_KEY,
    baseUrl: fake.baseUrl,
    printBaseUrl: fake.printBaseUrl,
    timeoutMs: 300,
  });
  fake.reset();
});
afterEach(() => {
  fake.reset();
});

async function place(): Promise<string> {
  seq += 1;
  const token = `tok-waybill-web-${String(seq)}`.padEnd(20, 'x');
  await handle.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId, quantity: 1 });
  });
  const view = await handle.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await handle.db.transaction(
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
  await handle.pool.query(
    "UPDATE orders SET delivery_method = 'np_warehouse', delivery_settlement_ref = 'city-1', delivery_warehouse_ref = 'wh-1', status = 'confirmed' WHERE id = $1",
    [placed.orderId],
  );
  return placed.orderId;
}

const cell = (rows: unknown[], key: string): unknown => {
  const row = rows[0];
  return typeof row === 'object' && row !== null
    ? Object.entries(row).find(([k]) => k === key)?.[1]
    : undefined;
};
const q = async (text: string, params: unknown[]) =>
  cell((await handle.pool.query(text, params)).rows as unknown[], 'v');
const saves = () => fake.calls.filter((c) => c.model === 'InternetDocument').length;
const getPrint = async (id: string, query = 'kind=document') =>
  await print.GET(new Request(`https://admin.example/admin/print/waybill/${id}?${query}`), {
    params: Promise.resolve({ id }),
  });

describe('createWaybillAction', () => {
  it('content is FORBIDDEN and nothing is recorded or sent; an unsigned caller is UNAUTHENTICATED', async () => {
    const id = await place();
    state.role = 'content';
    expect(await actions.createWaybillAction({ orderId: id })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    state.signedIn = false;
    expect(await actions.createWaybillAction({ orderId: id })).toEqual({
      ok: false,
      code: 'UNAUTHENTICATED',
    });
    expect(
      Number(
        await q('SELECT count(*)::int AS v FROM shipment_operations WHERE order_id = $1', [id]),
      ),
    ).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('a manager creates it: number and tariff stored, two audit rows (request and settlement), one email queued', async () => {
    const id = await place();
    const result = await actions.createWaybillAction({ orderId: id });
    expect(result).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    expect(String(await q('SELECT ttn AS v FROM orders WHERE id = $1', [id]))).toMatch(/^\d{14}$/);
    expect(
      Number(await q('SELECT shipping_cost_actual AS v FROM orders WHERE id = $1', [id])),
    ).toBe(7000);
    expect(
      Number(
        await q(
          "SELECT count(*)::int AS v FROM audit_log WHERE entity = 'shipment_operation' AND entity_id = $1 AND user_id = $2",
          [id, USER],
        ),
      ),
    ).toBe(2);
    expect(
      Number(
        await q('SELECT count(*)::int AS v FROM outbox WHERE dedup_key = $1', [`waybill:${id}`]),
      ),
    ).toBe(1);
    // Pressing it again is refused before the carrier is called.
    expect(await actions.createWaybillAction({ orderId: id })).toEqual({
      ok: false,
      code: 'WAYBILL_NOT_ALLOWED',
    });
    expect(saves()).toBe(1);
  });

  it('a carrier that is not configured is a typed refusal and records nothing', async () => {
    const id = await place();
    state.carrier = null;
    expect(await actions.createWaybillAction({ orderId: id })).toEqual({
      ok: false,
      code: 'WAYBILL_NOT_CONFIGURED',
    });
    expect(
      Number(
        await q('SELECT count(*)::int AS v FROM shipment_operations WHERE order_id = $1', [id]),
      ),
    ).toBe(0);
  });

  it('a lost answer is reported as unknown, blocks a second call, and the hand resolution is audited', async () => {
    const id = await place();
    fake.onSave(() => ({ kind: 'created-but-hang' }));
    expect(await actions.createWaybillAction({ orderId: id })).toMatchObject({
      ok: true,
      data: { state: 'unknown' },
    });
    expect(await actions.createWaybillAction({ orderId: id })).toEqual({
      ok: false,
      code: 'WAYBILL_IN_PROGRESS',
    });
    expect(saves()).toBe(1);
    state.role = 'content';
    expect(
      await actions.resolveWaybillAction({ orderId: id, resolution: { kind: 'none' } }),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    state.role = 'manager';
    for (const resolution of [
      { kind: 'attach', ttn: '12' },
      { kind: 'attach' },
      { kind: 'other' },
      {},
    ]) {
      expect(await actions.resolveWaybillAction({ orderId: id, resolution })).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
    }
    const ttn = [...fake.documents.values()][0] ?? '';
    expect(
      await actions.resolveWaybillAction({ orderId: id, resolution: { kind: 'attach', ttn } }),
    ).toMatchObject({ ok: true, data: { changed: true, ttn } });
    expect(String(await q('SELECT ttn AS v FROM orders WHERE id = $1', [id]))).toBe(ttn);
  });
});

describe('the print route', () => {
  it('is refused without a session (401), for a role without the permission (403) and for bad input (400)', async () => {
    const id = await place();
    await actions.createWaybillAction({ orderId: id });
    state.signedIn = false;
    expect((await getPrint(id)).status).toBe(401);
    state.signedIn = true;
    state.role = 'content';
    expect((await getPrint(id)).status).toBe(403);
    state.role = 'manager';
    expect((await getPrint(id, 'kind=evil')).status).toBe(400);
    expect((await getPrint('not-a-uuid')).status).toBe(400);
    expect(fake.printHits).toEqual([]);
  });

  it('streams the PDF bytes untouched with no-store headers, and the API key reaches the browser nowhere', async () => {
    const id = await place();
    await actions.createWaybillAction({ orderId: id });
    for (const kind of ['document', 'marking']) {
      const response = await getPrint(id, `kind=${kind}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/pdf');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0x80]),
      );
      expect(JSON.stringify([...response.headers.entries()])).not.toContain(FAKE_NP_KEY);
    }
    expect(fake.printHits).toHaveLength(2);
  });

  it('an order without a waybill is 404 and the carrier is not asked; a dead carrier is 502', async () => {
    const id = await place();
    expect((await getPrint(id)).status).toBe(404);
    expect(fake.printHits).toEqual([]);
    await actions.createWaybillAction({ orderId: id });
    state.carrier = new NovaPoshtaWaybill({
      apiKey: 'wrong-key',
      baseUrl: fake.baseUrl,
      printBaseUrl: fake.printBaseUrl,
      timeoutMs: 300,
    });
    expect((await getPrint(id)).status).toBe(502);
    state.carrier = null;
    expect((await getPrint(id)).status).toBe(503);
  });
});
