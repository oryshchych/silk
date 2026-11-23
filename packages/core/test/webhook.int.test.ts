/**
 * Payment webhooks end to end on real Postgres: real MonoProvider verifying
 * signatures from a local fake Mono (real EC key), separate connections and
 * barriers for every concurrency scenario (phase 0.5 criteria 5, 6, 7, 10).
 *
 * The Mono bodies follow the documented invoice shape; they are synthetic
 * until the sandbox token arrives (OWNER_QUEUE Q13).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { orders, paymentAttempts } from '@store/db/schema';
import { MonoProvider } from '@store/payments/mono';
import { startFakeMono, type FakeMono } from '@store/payments/test/fake-mono';
import { WayForPayProvider } from '@store/payments/wayforpay';
import {
  FAKE_ACCOUNT,
  FAKE_SECRET,
  startFakeWayForPay,
  type FakeWayForPay,
} from '@store/payments/test/fake-wayforpay';
import type { WebhookResult } from '@store/payments/types';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import {
  AttemptStillOpenError,
  AttemptUnresolvedError,
  OrderNotPayableError,
} from '../src/errors.ts';
import { createOrder } from '../src/orders/create-order.ts';
import { applyPaymentWebhook } from '../src/payments/apply-webhook.ts';
import { createPaymentAttempt, recordAttemptResult } from '../src/payments/attempts.ts';
import { handlePaymentWebhook, MAX_WEBHOOK_BODY_BYTES } from '../src/payments/handle-webhook.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let fake: FakeMono;
let mono: MonoProvider;
let world: TestWorld;
let admin: DbHandle;
let v1: string;
let orderId: string;
let attempt: { attemptId: string; localReference: string; amount: number };

beforeAll(async () => {
  fake = await startFakeMono();
  mono = new MonoProvider({
    pageHosts: ['pay.example'],
    baseUrl: fake.baseUrl,
    token: 't',
    timeoutMs: 500,
  });
});

afterAll(async () => {
  await fake.close();
});

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  [v1] = world.fixture.variantIds;
  const token = 'tok-webhook-test-cart';
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
        paymentProvider: 'mono',
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  orderId = placed.orderId;
  attempt = await admin.db.transaction(
    async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
  );
});

afterEach(async () => {
  await world.close();
});

const body = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    invoiceId: 'inv-1',
    status: 'success',
    amount: attempt.amount,
    ccy: 980,
    finalAmount: attempt.amount,
    reference: attempt.localReference,
    modifiedDate: '2026-11-22T10:00:00Z',
    ...over,
  });

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');

async function deliver(raw: string, signature: string = fake.sign(raw), handle?: DbHandle) {
  const db = handle ?? world.connect();
  return await handlePaymentWebhook(
    {
      provider: mono,
      runInTransaction: async (fn) => await db.db.transaction(async (tx) => await fn(tx)),
    },
    { rawBody: bytes(raw), headers: new Headers({ 'X-Sign': signature }), sourceIp: '203.0.113.7' },
  );
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await admin.db.execute<{ n: number }>(query);
  return result.rows[0]?.n ?? -1;
}

const countOf = async (table: string, where = sql`true`): Promise<number> =>
  await scalar(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${where}`);

async function state() {
  const [row] = await admin.db
    .select({
      payment: orders.paymentStatus,
      captured: orders.capturedTotal,
      paidAt: orders.paidAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  const [att] = await admin.db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attempt.attemptId));
  const stock = await admin.db.execute<{ stock: number; reserved: number }>(
    sql`SELECT stock_quantity AS stock, reserved_quantity AS reserved FROM product_variants WHERE id = ${v1}`,
  );
  return { order: row, attempt: att, stock: stock.rows[0] };
}

describe('criterion 5: the same webhook five times', () => {
  it('has one effect; every answer is the provider answer, duplicates included', async () => {
    const raw = body();
    const barrier = new Barrier(5);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await deliver(raw, fake.sign(raw), handle);
      }),
    );

    expect(results.filter((r) => r.outcome.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome.kind === 'duplicate')).toHaveLength(4);
    for (const { response } of results) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{}'); // Mono's own answer, also on 2nd to 5th delivery
    }

    const s = await state();
    expect(s.order).toMatchObject({ payment: 'paid', captured: attempt.amount });
    expect(s.attempt).toMatchObject({ status: 'paid', state: 'succeeded', externalId: 'inv-1' });
    expect(await countOf('payment_events')).toBe(1);
    expect(await countOf('outbox', sql`topic = 'email.payment-received'`)).toBe(1);
    expect(
      await countOf('order_status_history', sql`field = 'payment_status' AND to_status = 'paid'`),
    ).toBe(1);
  });

  it('a later sequential redelivery is also a duplicate', async () => {
    const raw = body();
    expect((await deliver(raw)).outcome.kind).toBe('applied');
    const again = await deliver(raw);
    expect(again.outcome.kind).toBe('duplicate');
    expect(again.response.status).toBe(200);
  });
});

describe('criterion 6: garbage with the right invoice id comes first', () => {
  it('goes to the quarantine, never takes the idempotency key; the genuine one applies', async () => {
    const raw = body();
    const junk = await deliver(raw, fake.foreignSign(raw));
    expect(junk.outcome.kind).toBe('unverified');
    expect(junk.response.status).toBe(400);
    expect(await countOf('webhook_quarantine')).toBe(1);
    expect(await countOf('payment_events')).toBe(0);

    const tampered = await deliver(raw.replace(String(attempt.amount), '100'), fake.sign(raw));
    expect(tampered.outcome.kind).toBe('unverified');
    expect(await countOf('webhook_quarantine')).toBe(2);

    const real = await deliver(raw);
    expect(real.outcome.kind).toBe('applied');
    expect((await state()).order?.payment).toBe('paid');
  });
});

describe('criterion 7: the webhook beats the redirect', () => {
  it('applies before the provider answer was recorded, and the late record does not regress it', async () => {
    expect((await state()).attempt?.externalId).toBeNull();
    expect((await deliver(body())).outcome.kind).toBe('applied');

    await admin.db.transaction(async (tx) => {
      await recordAttemptResult(tx, {
        attemptId: attempt.attemptId,
        result: { ok: true, redirectUrl: 'https://pay.example/x', externalId: 'inv-1' },
      });
    });
    await admin.db.transaction(async (tx) => {
      await recordAttemptResult(tx, {
        attemptId: attempt.attemptId,
        result: { ok: false, externalIdUnknown: true },
      });
    });
    const s = await state();
    expect(s.attempt).toMatchObject({ status: 'paid', state: 'succeeded', externalId: 'inv-1' });
    expect(s.order?.payment).toBe('paid');
  });
});

describe('ordering, money and stock', () => {
  it('authorized and paid arriving together: paid wins, stock is untouched, captured once (criterion 10)', async () => {
    const hold = body({
      status: 'hold',
      finalAmount: undefined,
      modifiedDate: '2026-11-22T10:00:00Z',
    });
    const paid = body({ modifiedDate: '2026-11-22T10:01:00Z' });
    const barrier = new Barrier(2);
    const run = async (raw: string) => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await deliver(raw, fake.sign(raw), handle);
    };
    await Promise.all([run(hold), run(paid)]);

    const s = await state();
    expect(s.attempt).toMatchObject({ status: 'paid', capturedAmount: attempt.amount });
    expect(s.order).toMatchObject({ payment: 'paid', captured: attempt.amount });
    // payment never moves stock: reserved stays 1 until shipping (ADR-18)
    expect(s.stock).toEqual({ stock: 1, reserved: 1 });
    expect(
      await countOf('stock_reservations', sql`expires_at IS NULL AND released_at IS NULL`),
    ).toBe(1);
    expect(await countOf('outbox', sql`topic = 'email.payment-received'`)).toBe(1);
  });

  it('an older message after paid is recorded and ignored', async () => {
    await deliver(body({ modifiedDate: '2026-11-22T10:01:00Z' }));
    const late = await deliver(
      body({ status: 'hold', finalAmount: undefined, modifiedDate: '2026-11-22T10:00:00Z' }),
    );
    expect(late.outcome).toMatchObject({ kind: 'ignored', reason: 'stale' });
    expect((await state()).attempt?.status).toBe('paid');
    expect(await countOf('payment_events', sql`error LIKE 'stale%'`)).toBe(1);
  });

  it('a paid attempt cannot be moved back by a later failure message', async () => {
    await deliver(body({ modifiedDate: '2026-11-22T10:00:00Z' }));
    const failure = await deliver(
      body({ status: 'failure', finalAmount: undefined, modifiedDate: '2026-11-22T10:05:00Z' }),
    );
    expect(failure.outcome).toMatchObject({ kind: 'ignored' });
    expect((await state()).attempt?.status).toBe('paid');
    expect((await state()).order?.captured).toBe(attempt.amount);
  });

  it('a failed attempt leaves the order retryable; processing changes nothing', async () => {
    expect(
      (await deliver(body({ status: 'processing', finalAmount: undefined }))).outcome.kind,
    ).toBe('ignored');
    const failed = await deliver(
      body({ status: 'failure', finalAmount: undefined, modifiedDate: '2026-11-22T10:02:00Z' }),
    );
    expect(failed.outcome.kind).toBe('applied');
    expect((await state()).order).toMatchObject({ payment: 'failed', captured: 0 });
    // and a fresh attempt can be opened on the same order
    const next = await admin.db.transaction(
      async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
    );
    expect(next.attemptNumber).toBe(2);
  });
});

describe('authentic but inconsistent messages are never credited', () => {
  it.each([
    ['amount', { amount: 100, finalAmount: 100 }],
    ['currency', { ccy: 840 }],
  ])('a wrong %s is rejected, stored with an error, and changes nothing', async (_name, over) => {
    const result = await deliver(body(over));
    expect(result.outcome.kind).toBe('rejected');
    const s = await state();
    expect(s.attempt?.status).toBe('pending');
    expect(s.order).toMatchObject({ payment: 'pending', captured: 0 });
    expect(await countOf('payment_events', sql`error IS NOT NULL AND applied_at IS NULL`)).toBe(1);
  });

  it('an invoice id that differs from the one bound to the attempt is rejected', async () => {
    await deliver(body({ status: 'processing', finalAmount: undefined }));
    const result = await deliver(
      body({ invoiceId: 'inv-OTHER', modifiedDate: '2026-11-22T10:03:00Z' }),
    );
    expect(result.outcome.kind).toBe('rejected');
    expect((await state()).order?.payment).toBe('pending');
  });

  it('a reference that names no attempt is quarantined, answered 200 so it is not retried forever', async () => {
    const result = await deliver(body({ reference: '00000000-0000-4000-8000-000000000000' }));
    expect(result.outcome.kind).toBe('unmatched');
    expect(result.response.status).toBe(200);
    expect(await countOf('webhook_quarantine')).toBe(1);
    const notUuid = await deliver(
      body({ reference: 'LS-2026-000001', modifiedDate: '2026-11-22T10:09:00Z' }),
    );
    expect(notUuid.outcome.kind).toBe('unmatched');
  });
});

describe('atomicity: receipt is not application', () => {
  it('a crash after the event insert leaves nothing behind, and the redelivery applies', async () => {
    const raw = body();
    const verified: WebhookResult | null = await mono.verifyWebhook(
      bytes(raw),
      new Headers({ 'X-Sign': fake.sign(raw) }),
    );
    if (verified === null) throw new Error('fixture must verify');

    await expect(
      world.connect().db.transaction(async (tx) => {
        const outcome = await applyPaymentWebhook(tx, 'mono', verified);
        expect(outcome.kind).toBe('applied');
        throw new Error('process died before commit');
      }),
    ).rejects.toThrow('died');

    expect(await countOf('payment_events')).toBe(0); // no "duplicate" left to swallow the retry
    expect((await state()).order?.payment).toBe('pending');
    expect((await deliver(raw)).outcome.kind).toBe('applied');
    expect((await state()).order?.payment).toBe('paid');
  });
});

describe('late payment after cancellation', () => {
  it('is recorded as a financial fact, alerts the manager and does not touch stock', async () => {
    await admin.db.execute(sql`UPDATE orders SET status = 'cancelled' WHERE id = ${orderId}`);
    await admin.db.execute(
      sql`UPDATE stock_reservations SET released_at = now(), release_reason = 'cancelled'`,
    );
    await admin.db.execute(sql`UPDATE product_variants SET reserved_quantity = 0 WHERE id = ${v1}`);

    expect((await deliver(body())).outcome.kind).toBe('applied');
    const s = await state();
    expect(s.order).toMatchObject({ payment: 'paid', captured: attempt.amount });
    expect(s.stock).toEqual({ stock: 1, reserved: 0 });
    expect(await countOf('outbox', sql`topic = 'alert.late-payment'`)).toBe(1);
    expect(await countOf('outbox', sql`topic = 'email.payment-received'`)).toBe(0);
  });
});

describe('payment attempts', () => {
  it('a superseded attempt can still be paid late; money is summed over attempts', async () => {
    // a fresh attempt is still waiting for the provider call: it cannot be replaced
    await expect(
      admin.db.transaction(
        async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
      ),
    ).rejects.toBeInstanceOf(AttemptStillOpenError);
    await admin.db.execute(
      sql`UPDATE payment_attempts SET created_at = now() - interval '10 minutes'`,
    );
    const second = await admin.db.transaction(
      async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
    );
    expect(second.attemptNumber).toBe(2);
    expect((await state()).attempt).toMatchObject({
      status: 'failed',
      failureReason: 'superseded',
    });

    expect((await deliver(body())).outcome.kind).toBe('applied'); // pays attempt 1
    expect((await state()).order).toMatchObject({ payment: 'paid', captured: attempt.amount });
  });

  it('an attempt with an unknown result blocks a new one; a paid order refuses one', async () => {
    await admin.db.transaction(async (tx) => {
      await recordAttemptResult(tx, {
        attemptId: attempt.attemptId,
        result: { ok: false, externalIdUnknown: true },
      });
    });
    await expect(
      admin.db.transaction(
        async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
      ),
    ).rejects.toBeInstanceOf(AttemptUnresolvedError);

    await deliver(body());
    await expect(
      admin.db.transaction(
        async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
      ),
    ).rejects.toBeInstanceOf(OrderNotPayableError);
  });
});

describe('review round: money-losing orderings and short captures', () => {
  it('a rejected or ignored NEWER message does not make a genuine older success stale', async () => {
    // reversed (T3) on a pending attempt is not an allowed transition: recorded, ignored
    const reversed = await deliver(
      body({ status: 'reversed', finalAmount: undefined, modifiedDate: '2026-11-22T10:03:00Z' }),
    );
    expect(reversed.outcome.kind).toBe('ignored');
    // the success (T2) arrives AFTER it, with an older version: it must still be credited
    const success = await deliver(body({ modifiedDate: '2026-11-22T10:02:00Z' }));
    expect(success.outcome.kind).toBe('applied');
    expect((await state()).order).toMatchObject({ payment: 'paid', captured: attempt.amount });
  });

  it('a processing message with a later version does not block an earlier success', async () => {
    await deliver(
      body({ status: 'processing', finalAmount: undefined, modifiedDate: '2026-11-22T10:05:00Z' }),
    );
    expect((await deliver(body({ modifiedDate: '2026-11-22T10:01:00Z' }))).outcome.kind).toBe(
      'applied',
    );
  });

  it('equal timestamps: paid wins whichever arrives first', async () => {
    const same = '2026-11-22T10:00:00Z';
    await deliver(body({ status: 'hold', finalAmount: undefined, modifiedDate: same }));
    await deliver(body({ modifiedDate: same }));
    expect((await state()).attempt?.status).toBe('paid');
  });

  it.each([
    ['zero', 0],
    ['partial', 100],
  ])(
    'a %s capture is not a payment: rejected, alerted, nothing credited',
    async (_name, captured) => {
      const result = await deliver(body({ finalAmount: captured }));
      expect(result.outcome.kind).toBe('rejected');
      const s = await state();
      expect(s.order).toMatchObject({ payment: 'pending', captured: 0, paidAt: null });
      expect(s.attempt?.status).toBe('pending');
      expect(await countOf('outbox', sql`topic = 'email.payment-received'`)).toBe(0);
      expect(await countOf('outbox', sql`topic = 'alert.payment-mismatch'`)).toBe(1);
      expect(
        await countOf('stock_reservations', sql`expires_at IS NULL AND released_at IS NULL`),
      ).toBe(0);
    },
  );

  it('a rejected message raises ONE alert however often it is redelivered', async () => {
    const raw = body({ amount: 100, finalAmount: 100 });
    await deliver(raw);
    await deliver(raw);
    await deliver(raw);
    expect(await countOf('outbox', sql`topic = 'alert.payment-mismatch'`)).toBe(1);
  });

  it('a signed message whose invoice id belongs to another attempt is rejected, not a retry loop', async () => {
    await admin.db.transaction(async (tx) => {
      await recordAttemptResult(tx, {
        attemptId: attempt.attemptId,
        result: { ok: true, redirectUrl: 'https://pay.example/a', externalId: 'inv-A' },
      });
    });
    await admin.db.execute(
      sql`UPDATE payment_attempts SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute'`,
    );
    const second = await admin.db.transaction(
      async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
    );
    const result = await deliver(
      body({
        invoiceId: 'inv-A',
        reference: second.localReference,
        amount: second.amount,
        finalAmount: second.amount,
      }),
    );
    expect(result.outcome).toMatchObject({ kind: 'rejected' });
    expect(result.response.status).toBe(200);
  });

  it('a reversed HOLD ends the attempt as failed instead of leaving it authorized', async () => {
    await deliver(
      body({ status: 'hold', finalAmount: undefined, modifiedDate: '2026-11-22T10:00:00Z' }),
    );
    expect((await state()).order?.payment).toBe('authorized');
    await deliver(
      body({ status: 'reversed', finalAmount: undefined, modifiedDate: '2026-11-22T10:10:00Z' }),
    );
    expect((await state()).order).toMatchObject({ payment: 'failed', captured: 0 });
  });
});

describe('review round: several attempts and live invoices', () => {
  it('a live invoice cannot be replaced; once it expired, a second one can, and paying both raises a double-payment alert', async () => {
    await admin.db.transaction(async (tx) => {
      await recordAttemptResult(tx, {
        attemptId: attempt.attemptId,
        result: { ok: true, redirectUrl: 'https://pay.example/1', externalId: 'inv-1' },
      });
    });
    await expect(
      admin.db.transaction(
        async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
      ),
    ).rejects.toBeInstanceOf(AttemptStillOpenError);

    await admin.db.execute(
      sql`UPDATE payment_attempts SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute'`,
    );
    const second = await admin.db.transaction(
      async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
    );
    expect((await deliver(body())).outcome.kind).toBe('applied'); // late payment on invoice 1
    const secondPaid = await deliver(
      body({
        invoiceId: 'inv-2',
        reference: second.localReference,
        amount: second.amount,
        finalAmount: second.amount,
        modifiedDate: '2026-11-22T10:20:00Z',
      }),
    );
    expect(secondPaid.outcome.kind).toBe('applied');

    expect((await state()).order?.captured).toBe(attempt.amount * 2);
    expect(await countOf('outbox', sql`topic = 'alert.double-payment'`)).toBe(1);
    expect(await countOf('outbox', sql`topic = 'email.payment-received'`)).toBe(1); // one mail per order
  });

  it('three attempts: the order status follows the best one', async () => {
    for (let n = 0; n < 2; n += 1) {
      await admin.db.execute(
        sql`UPDATE payment_attempts SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute'`,
      );
      await admin.db.transaction(
        async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
      );
    }
    const rows = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM payment_attempts WHERE status = 'failed'`,
    );
    expect(rows.rows[0]?.n).toBe(2);
    expect((await state()).order?.payment).toBe('pending');
  });

  it('an order whose reservation is gone cannot open a payment attempt', async () => {
    await admin.db.execute(
      sql`UPDATE stock_reservations SET released_at = now(), release_reason = 'expired'`,
    );
    await admin.db.execute(sql`UPDATE payment_attempts SET state = 'failed', status = 'failed'`);
    await expect(
      admin.db.transaction(
        async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
      ),
    ).rejects.toBeInstanceOf(OrderNotPayableError);
  });

  it('a payment on an order that lost its reservation (not cancelled) is a late payment', async () => {
    await admin.db.execute(
      sql`UPDATE stock_reservations SET released_at = now(), release_reason = 'expired'`,
    );
    await deliver(body());
    expect(await countOf('outbox', sql`topic = 'alert.late-payment'`)).toBe(1);
    expect(await countOf('outbox', sql`topic = 'email.payment-received'`)).toBe(0);
  });
});

describe('review round: concurrency between the webhook and the attempt', () => {
  it('a webhook racing recordAttemptResult ends paid, with the invoice id set once', async () => {
    const barrier = new Barrier(2);
    const hook = (async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await deliver(body(), undefined, handle);
    })();
    const record = (async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      await handle.db.transaction(async (tx) => {
        await recordAttemptResult(tx, {
          attemptId: attempt.attemptId,
          result: { ok: true, redirectUrl: 'https://pay.example/1', externalId: 'inv-1' },
        });
      });
    })();
    await Promise.all([hook, record]);
    const s = await state();
    expect(s.attempt).toMatchObject({ status: 'paid', state: 'succeeded', externalId: 'inv-1' });
    expect(s.order?.payment).toBe('paid');
  });
});

describe('the quarantine is bounded', () => {
  it('past the cap a refused message is answered 400 but no longer stored', async () => {
    const db = world.connect();
    const send = async (raw: string) =>
      await handlePaymentWebhook(
        {
          provider: mono,
          quarantineCap: 2,
          runInTransaction: async (fn) => await db.db.transaction(async (tx) => await fn(tx)),
        },
        { rawBody: bytes(raw), headers: new Headers({ 'X-Sign': 'garbage' }), sourceIp: null },
      );
    for (const n of [1, 2, 3, 4]) {
      expect((await send(body({ invoiceId: `flood-${String(n)}` }))).response.status).toBe(400);
    }
    expect(await countOf('webhook_quarantine')).toBe(2);
    // A genuine message is unaffected by a full quarantine.
    const genuine = body();
    expect((await deliver(genuine)).response.status).toBe(200);
    expect((await state()).order?.payment).toBe('paid');
  });
});

describe('review round: what the quarantine keeps', () => {
  it('an unverified body is stored as a hash and a short prefix, a NUL byte is not a 500', async () => {
    const huge = `${'x'.repeat(10_000)}\u0000tail`;
    const result = await deliver(huge, fake.sign('something else'));
    expect(result.response.status).toBe(400);
    const row = await admin.db.execute<{ raw_body: string }>(
      sql`SELECT raw_body FROM webhook_quarantine`,
    );
    const stored = row.rows[0]?.raw_body ?? '';
    expect(stored).toMatch(/^sha256:[0-9a-f]{64} bytes:10005/);
    expect(stored.length).toBeLessThan(2200);
    expect(stored).not.toContain('\u0000');
  });

  it('an authentic message for an unknown attempt keeps the validated subset, not card data', async () => {
    const raw = body({
      reference: '00000000-0000-4000-8000-000000000000',
      maskedPan: '444433******1111',
    });
    await deliver(raw);
    const row = await admin.db.execute<{ raw_body: string }>(
      sql`SELECT raw_body FROM webhook_quarantine`,
    );
    expect(row.rows[0]?.raw_body).not.toContain('maskedPan');
    expect(row.rows[0]?.raw_body).toContain('inv-1');
  });
});

describe('review round: a failure at any point rolls every table back', () => {
  it('compares all touched tables after a crash following the apply', async () => {
    const before = {
      attempts: await countOf('payment_attempts', sql`status = 'pending'`),
      history: await countOf('order_status_history'),
      audit: await countOf('audit_log'),
      outbox: await countOf('outbox'),
      lifted: await countOf('stock_reservations', sql`expires_at IS NULL`),
    };
    const raw = body();
    const verified = await mono.verifyWebhook(
      bytes(raw),
      new Headers({ 'X-Sign': fake.sign(raw) }),
    );
    if (verified === null) throw new Error('fixture must verify');
    await expect(
      world.connect().db.transaction(async (tx) => {
        await applyPaymentWebhook(tx, 'mono', verified);
        throw new Error('crash');
      }),
    ).rejects.toThrow('crash');

    expect({
      attempts: await countOf('payment_attempts', sql`status = 'pending'`),
      history: await countOf('order_status_history'),
      audit: await countOf('audit_log'),
      outbox: await countOf('outbox'),
      lifted: await countOf('stock_reservations', sql`expires_at IS NULL`),
    }).toEqual(before);
    expect((await state()).order).toMatchObject({ payment: 'pending', captured: 0, paidAt: null });
    expect(await countOf('payment_events')).toBe(0);
  });
});

describe('review round 2: double click, duplicates, foreign amounts', () => {
  it('two parallel requests for the same order open exactly one attempt', async () => {
    const token = 'tok-second-order-cart';
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, {
        cartToken: token,
        variantId: world.fixture.variantIds[1],
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
          contact: { email: 'c@example.com', phone: '+380501112244', name: 'Second' },
          delivery: { method: 'pickup' },
          paymentProvider: 'mono',
          promoCode: null,
          locale: 'uk',
          allowUnquoted: true,
          termsAccepted: true,
        }),
    );
    const barrier = new Barrier(2);
    const click = async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await handle.db.transaction(
        async (tx) => await createPaymentAttempt(tx, { orderId: placed.orderId, provider: 'mono' }),
      );
    };
    const results = await Promise.allSettled([click(), click()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(AttemptStillOpenError);
    expect(await countOf('payment_attempts', sql`order_id = ${placed.orderId}`)).toBe(1);
  });

  it('a late provider answer for a superseded attempt does not take over the order invoice id', async () => {
    await admin.db.execute(
      sql`UPDATE payment_attempts SET created_at = now() - interval '10 minutes'`,
    );
    const second = await admin.db.transaction(
      async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'mono' }),
    );
    await admin.db.transaction(async (tx) => {
      await recordAttemptResult(tx, {
        attemptId: attempt.attemptId, // the OLD attempt, answered late
        result: { ok: true, redirectUrl: 'https://pay.example/old', externalId: 'inv-OLD' },
      });
    });
    const [row] = await admin.db
      .select({ pid: orders.providerPaymentId, current: orders.currentPaymentAttemptId })
      .from(orders)
      .where(eq(orders.id, orderId));
    expect(row).toEqual({ pid: null, current: second.attemptId });
  });

  it('an earlier REJECTED message is re-evaluated on redelivery, never returned as a duplicate', async () => {
    const raw = body({ amount: 100, finalAmount: 100 });
    expect((await deliver(raw)).outcome.kind).toBe('rejected');
    expect((await deliver(raw)).outcome.kind).toBe('rejected');
    expect(await countOf('payment_events', sql`applied_at IS NULL AND error IS NOT NULL`)).toBe(1);
  });

  it.each(['hold', 'failure', 'expired'])(
    'a foreign amount on a %s message is rejected on its own, not only for paid',
    async (status) => {
      const result = await deliver(body({ status, amount: 100, finalAmount: undefined }));
      expect(result.outcome).toMatchObject({
        kind: 'rejected',
        reason: expect.stringContaining('amount') as string,
      });
      expect((await state()).attempt?.status).toBe('pending');
    },
  );

  it('a message for another provider than the attempt is rejected on its own', async () => {
    const raw = body();
    const verified = await mono.verifyWebhook(
      bytes(raw),
      new Headers({ 'X-Sign': fake.sign(raw) }),
    );
    if (verified === null) throw new Error('fixture must verify');
    const outcome = await world
      .connect()
      .db.transaction(async (tx) => await applyPaymentWebhook(tx, 'wayforpay', verified));
    expect(outcome).toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('provider') as string,
    });
    expect((await state()).order?.payment).toBe('pending');
  });

  it('a reservation past its expiry but not yet released by the worker is rescued by the payment', async () => {
    await admin.db.execute(
      sql`UPDATE stock_reservations SET expires_at = now() - interval '5 minutes' WHERE released_at IS NULL`,
    );
    await deliver(body());
    expect(
      await countOf('stock_reservations', sql`expires_at IS NULL AND released_at IS NULL`),
    ).toBe(1);
    expect(await countOf('outbox', sql`topic = 'email.payment-received'`)).toBe(1);
    expect(await countOf('outbox', sql`topic = 'alert.late-payment'`)).toBe(0);
  });
});

describe('WayForPay through the same pipeline (database, quarantine, signed accept)', () => {
  let wfpFake: FakeWayForPay;
  let wfp: WayForPayProvider;
  let wfpAttempt: { attemptId: string; localReference: string; amount: number };

  beforeAll(async () => {
    wfpFake = await startFakeWayForPay();
    wfp = new WayForPayProvider({
      pageHosts: ['secure.example'],
      baseUrl: wfpFake.baseUrl,
      merchantAccount: FAKE_ACCOUNT,
      secretKey: FAKE_SECRET,
      merchantDomainName: 'shop.example',
      now: () => 1_700_000_000,
    });
  });
  afterAll(async () => {
    await wfpFake.close();
  });
  beforeEach(async () => {
    // A second attempt by WayForPay on the order made in the outer beforeEach: the Mono attempt
    // is closed first (a live invoice cannot be replaced).
    await admin.db.execute(
      sql`UPDATE payment_attempts SET state = 'failed', status = 'failed', expires_at = now() - interval '1 minute' WHERE id = ${attempt.attemptId}`,
    );
    wfpAttempt = await admin.db.transaction(
      async (tx) => await createPaymentAttempt(tx, { orderId, provider: 'wayforpay' }),
    );
  });

  const callback = (over: Partial<Parameters<FakeWayForPay['callback']>[0]> = {}): string =>
    wfpFake.callback({
      orderReference: wfpAttempt.localReference,
      amount: wfpAttempt.amount / 100,
      transactionStatus: 'Approved',
      ...over,
    });

  async function deliverWfp(raw: string) {
    const db = world.connect();
    return await handlePaymentWebhook(
      {
        provider: wfp,
        runInTransaction: async (fn) => await db.db.transaction(async (tx) => await fn(tx)),
      },
      { rawBody: bytes(raw), headers: new Headers(), sourceIp: '203.0.113.9' },
    );
  }
  const acceptOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

  it('garbage with the genuine reference is quarantined, then the genuine callback applies', async () => {
    const garbage = await deliverWfp(callback({ secret: 'wrong-secret' }));
    expect(garbage.response.status).toBe(400);
    expect(await countOf('webhook_quarantine')).toBe(1);
    expect(await countOf('payment_events')).toBe(0);
    const genuine = await deliverWfp(callback());
    expect(genuine.response.status).toBe(200);
    expect(genuine.outcome.kind).toBe('applied');
    const [row] = await admin.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row).toMatchObject({ paymentStatus: 'paid', capturedTotal: wfpAttempt.amount });
  });

  it('the same callback five times in parallel has one effect and every answer is a signed accept', async () => {
    const raw = callback();
    const barrier = new Barrier(5);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        await barrier.wait();
        return await deliverWfp(raw);
      }),
    );
    expect(results.filter((r) => r.outcome.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome.kind === 'duplicate')).toHaveLength(4);
    for (const result of results) {
      const answer = await acceptOf(result.response);
      expect(answer).toMatchObject({ status: 'accept', orderReference: wfpAttempt.localReference });
      expect(typeof answer['signature']).toBe('string');
    }
    expect(await countOf('payment_events')).toBe(1);
  });

  it('a sequential redelivery is a duplicate and still gets the signed accept', async () => {
    await deliverWfp(callback());
    const again = await deliverWfp(callback());
    expect(again.outcome.kind).toBe('duplicate');
    expect(await acceptOf(again.response)).toMatchObject({ status: 'accept' });
  });

  it('a genuine callback for a reference we never issued is quarantined with the validated subset and answered 200', async () => {
    const stranger = await deliverWfp(
      wfpFake.callback({
        orderReference: '0192f3a0-0000-7000-8000-00000000f00d',
        amount: 5,
        transactionStatus: 'Approved',
      }),
    );
    expect(stranger.outcome.kind).toBe('unmatched');
    expect(stranger.response.status).toBe(200);
    expect(await countOf('webhook_quarantine')).toBe(1);
    expect(await countOf('payment_events')).toBe(0);
  });

  it('an amount that differs from the attempt is rejected with an alert, never credited', async () => {
    const result = await deliverWfp(callback({ amount: 1 }));
    expect(result.outcome.kind).toBe('rejected');
    const [row] = await admin.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row).toMatchObject({ paymentStatus: 'pending', capturedTotal: 0 });
    expect(await countOf('outbox', sql`topic = 'alert.payment-mismatch'`)).toBe(1);
  });

  it('a callback over the size cap is a 413 before parsing, and is stored nowhere', async () => {
    const huge = JSON.stringify({ pad: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1) });
    const result = await deliverWfp(huge);
    expect(result.response.status).toBe(413);
    expect(result.outcome.kind).toBe('too_large');
    expect(await countOf('webhook_quarantine')).toBe(0);
    expect(await countOf('payment_events')).toBe(0);
  });
});
