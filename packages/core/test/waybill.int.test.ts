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
  OrderHasWaybillError,
  WaybillInProgressError,
  WaybillNotAllowedError,
  WaybillNotConfiguredError,
} from '../src/errors.ts';
import { cancelOrder } from '../src/orders/fulfilment.ts';
import { editOrderItems } from '../src/orders-admin/edit-items.ts';
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
  // A card order is paid by the time it gets a waybill (the rule is the same as for shipping).
  if ((overrides.provider ?? 'mono') === 'mono') {
    await admin.db.execute(
      sql`UPDATE orders SET payment_status = 'paid', captured_total = total WHERE id = ${placed.orderId}`,
    );
  }
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

describe('review round 1 (#74): the order lifecycle around a waybill', () => {
  const cancel = async (orderId: string, expiredOnly = false) =>
    await admin.db.transaction(
      async (tx) =>
        await cancelOrder(tx, { orderId, source: 'admin', reason: 'test cancel', expiredOnly }),
    );

  it('B1(A): an order with a succeeded waybill cannot be cancelled; nothing changes', async () => {
    const orderId = await place({ provider: 'cod' });
    await run(orderId);
    await expect(cancel(orderId)).rejects.toBeInstanceOf(OrderHasWaybillError);
    expect(
      (await rows<{ status: string }>(sql`SELECT status FROM orders WHERE id = ${orderId}`))[0]
        ?.status,
    ).toBe('confirmed');
    expect((await ops(orderId))[0]?.state).toBe('succeeded');
  });

  it.each(['in_flight', 'unknown'])(
    'B1: a %s operation also blocks the cancellation (and the expiry path is a no-op)',
    async (state) => {
      const orderId = await place();
      await admin.db.execute(sql`UPDATE orders SET status = 'pending' WHERE id = ${orderId}`);
      await admin.db.execute(
        sql`INSERT INTO shipment_operations (order_id, carrier, state) VALUES (${orderId}, 'nova_poshta', ${state}::operation_state)`,
      );
      await expect(cancel(orderId)).rejects.toBeInstanceOf(OrderHasWaybillError);
      expect((await cancel(orderId, true)).changed).toBe(false);
    },
  );

  it('B1(C): an answer that arrives for an order cancelled meanwhile is settled, nobody is emailed, the owner is alerted', async () => {
    const orderId = await place();
    const begun = await admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId }));
    const result = await carrier.createWaybill(begun.request);
    // Forced past the guard (a manual SQL change): the re-check is the second line of defence.
    await admin.db.execute(sql`UPDATE orders SET status = 'cancelled' WHERE id = ${orderId}`);
    const done = await admin.db.transaction(
      async (tx) =>
        await completeWaybill(tx, { operationId: begun.operationId, result, actorUserId: USER }),
    );
    expect(done).toMatchObject({ state: 'succeeded', changed: true });
    expect(
      await rows(sql`SELECT 1 FROM outbox WHERE topic = 'email.waybill-created'`),
    ).toHaveLength(0);
    expect(
      await rows(
        sql`SELECT 1 FROM outbox WHERE topic = 'alert.waybill-for-cancelled-order' AND dedup_key = ${`waybill-cancelled:${orderId}`}`,
      ),
    ).toHaveLength(1);
  });

  it.each(['in_flight', 'unknown', 'succeeded'])(
    'B2: editing items is refused while a %s waybill exists',
    async (state) => {
      const orderId = await place();
      const [item] = await rows<{ id: string }>(
        sql`SELECT id FROM order_items WHERE order_id = ${orderId}`,
      );
      await admin.db.execute(
        sql`INSERT INTO shipment_operations (order_id, carrier, state) VALUES (${orderId}, 'nova_poshta', ${state}::operation_state)`,
      );
      await expect(
        admin.db.transaction(
          async (tx) =>
            await editOrderItems(tx, {
              orderId,
              changes: [{ itemId: item?.id ?? '', quantity: 1 }],
              reason: 'try edit',
              actorUserId: USER,
            }),
        ),
      ).rejects.toBeInstanceOf(OrderHasWaybillError);
    },
  );

  it('S1: a card order must be paid and not partly refunded, like shipping', async () => {
    const orderId = await place();
    await admin.db.execute(
      sql`UPDATE orders SET payment_status = 'pending', captured_total = 0 WHERE id = ${orderId}`,
    );
    await expect(
      admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId })),
    ).rejects.toBeInstanceOf(WaybillNotAllowedError);
    await admin.db.execute(
      sql`UPDATE orders SET payment_status = 'paid', captured_total = total WHERE id = ${orderId}`,
    );
    await admin.db.execute(
      sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id) SELECT id, 1, 'mono', total, 'succeeded', 'paid', total, 'inv-wb' FROM orders WHERE id = ${orderId}`,
    );
    await admin.db.execute(
      sql`INSERT INTO refund_operations (order_id, payment_attempt_id, amount, state) SELECT ${orderId}::uuid, id, 1000, 'pending'::operation_state FROM payment_attempts WHERE order_id = ${orderId}`,
    );
    await expect(
      admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId })),
    ).rejects.toBeInstanceOf(WaybillNotAllowedError);
    await admin.db.execute(
      sql`UPDATE refund_operations SET state = 'failed' WHERE order_id = ${orderId}`,
    );
    expect((await run(orderId)).done.state).toBe('succeeded');
    expect((await orderTtn(orderId))?.ttn).toMatch(/^\d{14}$/);
  });

  it('S2 and S3: the COD amount is the total minus what was received, with shipping and a discount in the maths', async () => {
    const orderId = await place({ provider: 'cod', quantity: 2 });
    // subtotal 259 800, a discount of 10 000, shipping 7 000, 2 000 already received.
    await admin.db.execute(
      sql`UPDATE order_items SET line_discount = 10000, line_total = unit_price * quantity - 10000 WHERE order_id = ${orderId}`,
    );
    await admin.db.execute(
      sql`UPDATE orders SET discount_total = 10000, shipping_total = 7000, total = subtotal - 10000 + 7000, captured_total = 2000 WHERE id = ${orderId}`,
    );
    await run(orderId);
    const save = fake.calls.find((c) => c.model === 'InternetDocument');
    expect(save?.properties['BackwardDeliveryData']).toEqual([
      { PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: '2548.00' },
    ]);
    // The declared value is the goods after the discount.
    expect(save?.properties['Cost']).toBe('2498.00');
  });

  it('S2: a COD order that already received everything collects nothing; one that received MORE is refused', async () => {
    const paid = await place({ provider: 'cod' });
    await admin.db.execute(sql`UPDATE orders SET captured_total = total WHERE id = ${paid}`);
    await run(paid);
    expect(
      fake.calls.find((c) => c.model === 'InternetDocument')?.properties['BackwardDeliveryData'],
    ).toBeUndefined();
    const over = await place({ provider: 'cod' });
    await admin.db.execute(sql`UPDATE orders SET captured_total = total + 100 WHERE id = ${over}`);
    await expect(
      admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId: over })),
    ).rejects.toBeInstanceOf(WaybillNotAllowedError);
  });

  it('"nothing was made" is refused while the call may still be running, and attach is refused for a cancelled order', async () => {
    const orderId = await place();
    const begun = await admin.db.transaction(async (tx) => await beginWaybill(tx, { orderId }));
    await expect(
      admin.db.transaction(
        async (tx) =>
          await resolveWaybill(tx, { orderId, resolution: { kind: 'none' }, actorUserId: USER }),
      ),
    ).rejects.toBeInstanceOf(WaybillInProgressError);
    await admin.db.execute(
      sql`UPDATE shipment_operations SET created_at = now() - interval '5 minutes' WHERE id = ${begun.operationId}`,
    );
    expect(
      (
        await admin.db.transaction(
          async (tx) =>
            await resolveWaybill(tx, { orderId, resolution: { kind: 'none' }, actorUserId: USER }),
        )
      ).changed,
    ).toBe(true);
    const other = await place();
    await admin.db.execute(
      sql`INSERT INTO shipment_operations (order_id, carrier, state) VALUES (${other}, 'nova_poshta', 'unknown')`,
    );
    await admin.db.execute(sql`UPDATE orders SET status = 'cancelled' WHERE id = ${other}`);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await resolveWaybill(tx, {
            orderId: other,
            resolution: { kind: 'attach', ttn: '59000000000077' },
            actorUserId: USER,
          }),
      ),
    ).rejects.toBeInstanceOf(WaybillNotAllowedError);
  });

  it('completeWaybill reports the real state of an operation that was already settled', async () => {
    const orderId = await place();
    fake.onSave(() => ({ kind: 'hang' }));
    const first = await run(orderId);
    expect(first.done.state).toBe('unknown');
    const again = await admin.db.transaction(
      async (tx) =>
        await completeWaybill(tx, {
          operationId: first.begun.operationId,
          result: { state: 'failed', error: 'late' },
          actorUserId: USER,
        }),
    );
    expect(again).toMatchObject({ changed: false, state: 'unknown' });
  });
});
