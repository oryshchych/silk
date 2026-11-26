/**
 * Nova Poshta waybills on real Postgres with the real adapter against the local fake carrier (real
 * HTTP, separate connections). The rule under test: a call whose result is unknown is NEVER
 * repeated, and the database allows one live operation per order.
 */
import { sql } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { NovaPoshtaWaybill } from '@store/payments/nova-poshta';
import {
  FAKE_NP_KEY,
  startFakeNovaPoshta,
  type FakeNovaPoshta,
} from '@store/payments/test/fake-nova-poshta';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import {
  WaybillInProgressError,
  WaybillNotAllowedError,
  WaybillNotConfiguredError,
} from '../src/errors.ts';
import { createOrder } from '../src/orders/create-order.ts';
import {
  beginWaybill,
  completeWaybill,
  resolveWaybill,
  splitName,
} from '../src/shipping/waybill.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const USER = '00000000-0000-4000-8000-0000000000aa';
let fake: FakeNovaPoshta;
let carrier: NovaPoshtaWaybill;
let world: TestWorld;
let admin: DbHandle;
let v1: string;
let seq = 0;

beforeAll(async () => {
  fake = await startFakeNovaPoshta();
  carrier = new NovaPoshtaWaybill({
    apiKey: FAKE_NP_KEY,
    baseUrl: fake.baseUrl,
    printBaseUrl: fake.printBaseUrl,
    timeoutMs: 300,
  });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  world = await createWorld();
  admin = world.connect(2);
  [v1] = world.fixture.variantIds;
  await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 20`);
  await admin.db.execute(
    sql`INSERT INTO settings (key, value) VALUES ('np_sender', ${JSON.stringify({ cityRef: 'c', senderRef: 's', contactRef: 'k', addressRef: 'a', phone: '+380441112233' })}::jsonb)`,
  );
});
afterEach(async () => {
  await world.close();
});

/** A confirmed Nova Poshta branch order. */
async function place(
  overrides: { provider?: 'mono' | 'cod'; name?: string; quantity?: number } = {},
): Promise<string> {
  seq += 1;
  const token = `tok-waybill-${String(seq)}`.padEnd(20, 'x');
  await admin.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId: v1, quantity: overrides.quantity ?? 2 });
  });
  const view = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await admin.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: view.intentId,
        ownerToken: token,
        contact: {
          email: 'b@example.com',
          phone: '+380501112233',
          name: overrides.name ?? 'Петренко Іван',
        },
        delivery: { method: 'pickup' },
        paymentProvider: overrides.provider ?? 'mono',
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  await admin.db.execute(
    sql`UPDATE orders SET delivery_method = 'np_warehouse', delivery_settlement_ref = 'city-1', delivery_warehouse_ref = 'wh-1',
                          delivery_warehouse_name = 'Відділення 1', status = 'confirmed' WHERE id = ${placed.orderId}`,
  );
  return placed.orderId;
}

async function rows<T extends QueryResultRow>(query: ReturnType<typeof sql>) {
  return (await admin.db.execute<T>(query)).rows;
}
const ops = async (orderId: string) =>
  await rows<{ state: string; ttn: string | null; err: string | null }>(
    sql`SELECT state, ttn, last_error AS err FROM shipment_operations WHERE order_id = ${orderId} ORDER BY created_at`,
  );
const orderTtn = async (orderId: string) =>
  (
    await rows<{ ttn: string | null; cost: number | null }>(
      sql`SELECT ttn, shipping_cost_actual AS cost FROM orders WHERE id = ${orderId}`,
    )
  )[0];
const saves = () =>
  fake.calls.filter((c) => c.model === 'InternetDocument' && c.method === 'save').length;

/** The three steps the action runs: record and commit, call the carrier, settle. */
async function run(orderId: string, handle: DbHandle = admin) {
  const begun = await handle.db.transaction(async (tx) => await beginWaybill(tx, { orderId }));
  const result = await carrier.createWaybill(begun.request);
  const done = await handle.db.transaction(
    async (tx) =>
      await completeWaybill(tx, { operationId: begun.operationId, result, actorUserId: USER }),
  );
  return { begun, result, done };
}

describe('the happy path', () => {
  it('stores the number and the REAL tariff, writes history and one outbox email, and calls the carrier once', async () => {
    fake.onSave(() => ({ kind: 'ok', cost: '82.5' }));
    const orderId = await place({ quantity: 3 });
    const { begun, done } = await run(orderId);
    expect(done).toMatchObject({ state: 'succeeded', changed: true });
    const order = await orderTtn(orderId);
    expect(order?.ttn).toMatch(/^\d{14}$/);
    expect(order?.cost).toBe(8250);
    expect((await ops(orderId))[0]).toMatchObject({ state: 'succeeded', ttn: order?.ttn });
    expect(
      await rows(
        sql`SELECT 1 FROM order_status_history WHERE order_id = ${orderId} AND field = 'ttn' AND changed_by_user_id = ${USER}`,
      ),
    ).toHaveLength(1);
    expect(
      await rows(
        sql`SELECT 1 FROM outbox WHERE topic = 'email.waybill-created' AND dedup_key = ${`waybill:${orderId}`}`,
      ),
    ).toHaveLength(1);
    expect(saves()).toBe(1);
    // 3 units at the default 200 g, the recipient from the order, our reference inside the document.
    const save = fake.calls.find((c) => c.model === 'InternetDocument');
    expect(save?.properties).toMatchObject({
      Weight: '0.600',
      InfoRegClientBarcodes: begun.request.localReference,
      CityRecipient: 'city-1',
      RecipientAddress: 'wh-1',
    });
    expect(begun.request.recipient).toMatchObject({ lastName: 'Петренко', firstName: 'Іван' });
    // Settling twice changes nothing.
    const again = await admin.db.transaction(
      async (tx) =>
        await completeWaybill(tx, {
          operationId: begun.operationId,
          result: { state: 'failed', error: 'late' },
          actorUserId: USER,
        }),
    );
    expect(again.changed).toBe(false);
    expect((await orderTtn(orderId))?.ttn).toBe(order?.ttn);
  });

  it('a cash-on-delivery order asks the carrier to collect the total', async () => {
    const orderId = await place({ provider: 'cod' });
    await run(orderId);
    const total =
      (await rows<{ total: number }>(sql`SELECT total FROM orders WHERE id = ${orderId}`))[0]
        ?.total ?? 0;
    const save = fake.calls.find((c) => c.model === 'InternetDocument');
    expect(save?.properties['BackwardDeliveryData']).toEqual([
      {
        PayerType: 'Recipient',
        CargoType: 'Money',
        RedeliveryString: `${String(Math.trunc(total / 100))}.${String(total % 100).padStart(2, '0')}`,
      },
    ]);
  });
});

describe('refusals before any call', () => {
  it.each([
    ['a pickup order', sql`UPDATE orders SET delivery_method = 'pickup'`],
    ['a pending order', sql`UPDATE orders SET status = 'pending'`],
    ['a cancelled order', sql`UPDATE orders SET status = 'cancelled'`],
    ['a one-word recipient name', sql`UPDATE orders SET customer_name = 'Іван'`],
    ['no destination city', sql`UPDATE orders SET delivery_settlement_ref = NULL`],
    ['a branch order without a branch', sql`UPDATE orders SET delivery_warehouse_ref = NULL`],
  ])('%s is refused and nothing is recorded or sent', async (_name, change) => {
    const orderId = await place();
    await admin.db.execute(change);
    await expect(
      admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId })),
    ).rejects.toBeInstanceOf(WaybillNotAllowedError);
    expect(await ops(orderId)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('a missing sender profile is NOT_CONFIGURED', async () => {
    const orderId = await place();
    await admin.db.execute(sql`DELETE FROM settings WHERE key = 'np_sender'`);
    await expect(
      admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId })),
    ).rejects.toBeInstanceOf(WaybillNotConfiguredError);
    await admin.db.execute(
      sql`INSERT INTO settings (key, value) VALUES ('np_sender', '{"cityRef":"c"}'::jsonb)`,
    );
    await expect(
      admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId })),
    ).rejects.toBeInstanceOf(WaybillNotConfiguredError);
    expect(fake.calls).toHaveLength(0);
  });

  it('splits "Last First" names and refuses a single word', () => {
    expect(splitName('  Петренко   Іван Іванович ')).toEqual({
      lastName: 'Петренко',
      firstName: 'Іван',
    });
    expect(splitName('Іван')).toBeNull();
    expect(splitName('   ')).toBeNull();
  });
});

describe('a refusal frees the order, an unknown result never does', () => {
  it('the carrier says no: the operation is failed and a second try may succeed', async () => {
    const orderId = await place();
    fake.onSave(() => ({ kind: 'error', errors: ['Recipient phone is invalid'] }));
    const first = await run(orderId);
    expect(first.done.state).toBe('failed');
    expect((await orderTtn(orderId))?.ttn).toBeNull();
    fake.onSave(() => ({ kind: 'ok' }));
    expect((await run(orderId)).done.state).toBe('succeeded');
    expect((await ops(orderId)).map((o) => o.state)).toEqual(['failed', 'succeeded']);
  });

  it('a lost answer leaves the operation live: a second click calls nothing, and the document that WAS made is attached by hand', async () => {
    const orderId = await place();
    fake.onSave(() => ({ kind: 'created-but-hang' }));
    const first = await run(orderId);
    expect(first.done.state).toBe('unknown');
    expect(fake.documents.size).toBe(1); // the carrier made it: a retry would have made a second
    const calls = saves();
    await expect(
      admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId })),
    ).rejects.toBeInstanceOf(WaybillInProgressError);
    expect(saves()).toBe(calls);
    expect((await orderTtn(orderId))?.ttn).toBeNull();

    const ttn = [...fake.documents.values()][0] ?? '';
    await expect(
      admin.db.transaction(
        async (tx) =>
          await resolveWaybill(tx, {
            orderId,
            resolution: { kind: 'attach', ttn: '123' },
            actorUserId: USER,
          }),
      ),
    ).rejects.toBeInstanceOf(WaybillNotAllowedError);
    const resolved = await admin.db.transaction(
      async (tx) =>
        await resolveWaybill(tx, {
          orderId,
          resolution: { kind: 'attach', ttn },
          actorUserId: USER,
        }),
    );
    expect(resolved).toEqual({ changed: true, ttn });
    expect((await orderTtn(orderId))?.ttn).toBe(ttn);
    expect(
      await rows(sql`SELECT 1 FROM outbox WHERE dedup_key = ${`waybill:${orderId}`}`),
    ).toHaveLength(1);
    expect(
      (
        await admin.db.transaction(
          async (tx) =>
            await resolveWaybill(tx, { orderId, resolution: { kind: 'none' }, actorUserId: USER }),
        )
      ).changed,
    ).toBe(false);
  });

  it('"nothing was made" closes the unknown operation and frees the order', async () => {
    const orderId = await place();
    fake.onSave(() => ({ kind: 'hang' }));
    expect((await run(orderId)).done.state).toBe('unknown');
    await admin.db.transaction(
      async (tx) =>
        await resolveWaybill(tx, { orderId, resolution: { kind: 'none' }, actorUserId: USER }),
    );
    fake.onSave(() => ({ kind: 'ok' }));
    expect((await run(orderId)).done.state).toBe('succeeded');
  });

  it('a number that belongs to another order cannot be attached', async () => {
    const first = await place();
    const second = await place();
    fake.onSave(() => ({ kind: 'ok' }));
    await run(first);
    const used = (await orderTtn(first))?.ttn ?? '';
    fake.onSave(() => ({ kind: 'hang' }));
    await run(second);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await resolveWaybill(tx, {
            orderId: second,
            resolution: { kind: 'attach', ttn: used },
            actorUserId: USER,
          }),
      ),
    ).rejects.toBeInstanceOf(WaybillNotAllowedError);
  });

  it('a crash after the operation was recorded (the settle transaction fails) leaves it live, not lost', async () => {
    const orderId = await place();
    const begun = await admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId }));
    const result = await carrier.createWaybill(begun.request);
    await expect(
      admin.db.transaction(async (tx) => {
        await completeWaybill(tx, { operationId: begun.operationId, result, actorUserId: USER });
        throw new Error('the settle transaction failed');
      }),
    ).rejects.toThrow('settle transaction');
    expect((await ops(orderId))[0]?.state).toBe('in_flight');
    expect((await orderTtn(orderId))?.ttn).toBeNull();
    await expect(
      admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId })),
    ).rejects.toBeInstanceOf(WaybillInProgressError);
  });
});

describe('races (separate connections)', () => {
  it('two managers pressing Create at once: one operation row, one carrier call', async () => {
    const orderId = await place();
    const barrier = new Barrier(2);
    const attempt = async () => {
      const handle = world.connect();
      try {
        const begun = await handle.db.transaction(async (tx) => {
          await barrier.wait();
          return await beginWaybill(tx, { orderId });
        });
        const result = await carrier.createWaybill(begun.request);
        await handle.db.transaction(
          async (tx) =>
            await completeWaybill(tx, {
              operationId: begun.operationId,
              result,
              actorUserId: USER,
            }),
        );
        return 'won';
      } catch (error) {
        return error;
      }
    };
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(
      results.filter(
        (r) => r instanceof WaybillInProgressError || r instanceof WaybillNotAllowedError,
      ),
    ).toHaveLength(1);
    expect(await ops(orderId)).toHaveLength(1);
    expect(saves()).toBe(1);
  });

  it('the unique index holds even if the application check is bypassed', async () => {
    const orderId = await place();
    await admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId }));
    await expect(
      admin.db.execute(
        sql`INSERT INTO shipment_operations (order_id, carrier, state) VALUES (${orderId}, 'nova_poshta', 'pending')`,
      ),
    ).rejects.toThrow();
  });
});
