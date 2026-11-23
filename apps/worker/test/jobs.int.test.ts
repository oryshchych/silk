/**
 * The order email consumer and the scheduled jobs on real Postgres and a real pg-boss.
 * Orders are made through the core functions, exactly as checkout does.
 */
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setCartItem, startCheckout } from '@store/core/cart';
import { createOrder } from '@store/core/orders';
import { quoteCheckout } from '@store/core/quote';
import { createDb, type DbHandle } from '@store/db/client';
import { settings } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { startBoss } from '../src/boss.ts';
import { handleOrderCreated, OrderEmailError } from '../src/email/order-created.ts';
import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { createJobHandlers, JOB_NAMES, registerJobs } from '../src/jobs.ts';
import { createMessageSender, UnhandledTopicError } from '../src/router.ts';

let testDb: TestDatabase;
let app: DbHandle;
let variantId = '';

beforeEach(async () => {
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 3 });
  const fixture = await app.db.transaction(async (tx) => {
    await tx.insert(settings).values([
      { key: 'payment_providers', value: { cod: true, bank_transfer: true } },
      { key: 'contacts', value: { email: 'shop@example.com' } },
    ]);
    return await seedMoneySkeleton(tx);
  });
  variantId = fixture.variantIds[0];
  await app.db.execute(sql`UPDATE product_variants SET stock_quantity = 50`);
});
afterEach(async () => {
  await app.close();
  await testDb.drop();
});

const token = (name: string): string => `tok-${name}`.padEnd(20, 'x');

async function placeOrder(name: string, over: { locale?: 'uk' | 'en'; name?: string } = {}) {
  await app.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token(name), variantId, quantity: 1 });
  });
  const intent = await app.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token(name) }),
  );
  await app.db.transaction(async (tx) => {
    await quoteCheckout(tx, {
      cartToken: token(name),
      intentId: intent.intentId,
      delivery: 'pickup',
      promoCode: null,
    });
  });
  return await app.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: intent.intentId,
        ownerToken: token(name),
        contact: { email: 'buyer@example.com', phone: '+380501234567', name: over.name ?? 'Buyer' },
        delivery: { method: 'pickup' },
        paymentProvider: 'cod',
        promoCode: null,
        locale: over.locale ?? 'uk',
        termsAccepted: true,
      }),
  );
}

class Recorder implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failOn: string | null = null;
  send(message: EmailMessage): Promise<void> {
    if (this.failOn !== null && message.idempotencyKey.endsWith(this.failOn)) {
      return Promise.reject(new Error('provider down'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe('email.order-created', () => {
  it('sends the buyer a confirmation and the shop a notification, loaded from the database by id', async () => {
    const placed = await placeOrder('mail1', { name: 'Ірина <b>' });
    const email = new Recorder();
    await handleOrderCreated(
      { reader: app.db, sender: email, siteUrl: 'https://shop.example' },
      { dedupKey: `order-created:${placed.orderId}`, payload: { orderId: placed.orderId } },
    );
    expect(email.sent.map((m) => m.to)).toEqual(['buyer@example.com', 'shop@example.com']);
    expect(email.sent[0]?.subject).toContain(placed.orderNumber);
    expect(email.sent[0]?.html).toContain('Ірина &lt;b&gt;');
    expect(email.sent[0]?.text).toContain('https://shop.example/order/track');
    expect(email.sent.map((m) => m.idempotencyKey)).toEqual([
      `order-created:${placed.orderId}:customer`,
      `order-created:${placed.orderId}:admin`,
    ]);
  });

  it('an English order gets the English mail and the English tracking path', async () => {
    const placed = await placeOrder('mail2', { locale: 'en' });
    const email = new Recorder();
    await handleOrderCreated(
      { reader: app.db, sender: email, siteUrl: 'https://shop.example' },
      { dedupKey: 'k', payload: { orderId: placed.orderId } },
    );
    expect(email.sent[0]?.subject).toBe(`Order ${placed.orderNumber} placed`);
    expect(email.sent[0]?.text).toContain('https://shop.example/en/order/track');
  });

  it('a failing shop notification fails the job; the retry re-sends with the same keys', async () => {
    const placed = await placeOrder('mail3');
    const email = new Recorder();
    email.failOn = ':admin';
    const deps = { reader: app.db, sender: email, siteUrl: 'https://shop.example' };
    const message = { dedupKey: 'dk', payload: { orderId: placed.orderId } };
    await expect(handleOrderCreated(deps, message)).rejects.toThrow('provider down');
    email.failOn = null;
    await handleOrderCreated(deps, message);
    // The customer key repeats: the provider drops the duplicate while it remembers the key.
    expect(email.sent.map((m) => m.idempotencyKey)).toEqual([
      'dk:customer',
      'dk:customer',
      'dk:admin',
    ]);
  });

  it('no shop address configured means no staff mail; bad payloads and unknown orders fail', async () => {
    const placed = await placeOrder('mail4');
    await app.db.execute(sql`DELETE FROM settings WHERE key = 'contacts'`);
    const email = new Recorder();
    const deps = { reader: app.db, sender: email, siteUrl: 'https://shop.example' };
    await handleOrderCreated(deps, { dedupKey: 'x', payload: { orderId: placed.orderId } });
    expect(email.sent).toHaveLength(1);
    await expect(
      handleOrderCreated(deps, { dedupKey: 'x', payload: { orderId: 'nope' } }),
    ).rejects.toBeInstanceOf(OrderEmailError);
    await expect(
      handleOrderCreated(deps, {
        dedupKey: 'x',
        payload: { orderId: '0193f0a4-7c3e-7000-8000-000000000001' },
      }),
    ).rejects.toBeInstanceOf(OrderEmailError);
  });
});

describe('the message router', () => {
  it('routes the order email, logs an alert with ids only, and fails an unknown topic loudly', async () => {
    const placed = await placeOrder('route1');
    const email = new Recorder();
    const logs: string[] = [];
    const sender = createMessageSender({
      reader: app.db,
      email,
      siteUrl: 'https://shop.example',
      log: (l) => logs.push(l),
    });
    await sender.send({
      idempotencyKey: 'a',
      topic: 'email.order-created',
      payload: { orderId: placed.orderId },
    });
    expect(email.sent).toHaveLength(2);
    await sender.send({
      idempotencyKey: 'b',
      topic: 'alert.late-payment',
      payload: { orderId: placed.orderId, email: 'x@example.com' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(placed.orderId);
    expect(logs[0]).not.toContain('x@example.com');
    await expect(
      sender.send({ idempotencyKey: 'c', topic: 'email.payment-received', payload: {} }),
    ).rejects.toBeInstanceOf(UnhandledTopicError);
  });
});

describe('scheduled jobs', () => {
  let boss: PgBoss;
  beforeEach(async () => {
    boss = await startBoss(testDb.bossUrl, { retryLimit: 0, retryDelay: 0, retryBackoff: false });
  });
  afterEach(async () => {
    await boss.stop({ graceful: false });
  });

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 80 && !check(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 250));
    expect(check()).toBe(true);
  }

  it('the expiry job releases an expired reservation when pg-boss runs it, and the counters match', async () => {
    const placed = await placeOrder('job1');
    await app.db.execute(
      sql`UPDATE stock_reservations SET expires_at = now() - interval '1 minute'`,
    );
    const logs: string[] = [];
    await registerJobs(
      boss,
      createJobHandlers({ db: app.db, directory: null, log: (l) => logs.push(l) }),
    );
    await boss.send(JOB_NAMES.releaseExpired, {});
    await until(() => logs.some((l) => l.includes(JOB_NAMES.releaseExpired)));
    const line = JSON.parse(
      logs.find((l) => l.includes(JOB_NAMES.releaseExpired)) ?? '{}',
    ) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', expired: 1, failed: 0 });
    const [row] = (
      await app.db.execute<{ status: string; reason: string; reserved: number }>(
        sql`SELECT o.status, r.release_reason AS reason,
                   (SELECT reserved_quantity FROM product_variants WHERE id = ${variantId}) AS reserved
              FROM orders o JOIN stock_reservations r ON r.order_id = o.id WHERE o.id = ${placed.orderId}`,
      )
    ).rows;
    expect(row).toEqual({ status: 'cancelled', reason: 'expired', reserved: 0 });
  });

  it('the schedules exist with the Kyiv timezone, one per job', async () => {
    await registerJobs(
      boss,
      createJobHandlers({ db: app.db, directory: null, log: () => undefined }),
    );
    const schedules = await boss.getSchedules();
    expect(schedules.map((s) => s.name).sort()).toEqual(Object.values(JOB_NAMES).sort());
    expect(schedules.every((s) => s.timezone === 'Europe/Kyiv')).toBe(true);
  });

  it('the reconcile job reports a drifted counter at error level, ids only', async () => {
    await placeOrder('job2');
    await app.db.execute(
      sql`UPDATE product_variants SET reserved_quantity = reserved_quantity + 3`,
    );
    const logs: string[] = [];
    const handlers = createJobHandlers({ db: app.db, directory: null, log: (l) => logs.push(l) });
    await handlers[JOB_NAMES.reconcileStock]();
    const line = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', scope: JOB_NAMES.reconcileStock, drifted: 2 });
  });

  it('the sync job without a carrier key skips with a warning instead of failing', async () => {
    const logs: string[] = [];
    const handlers = createJobHandlers({ db: app.db, directory: null, log: (l) => logs.push(l) });
    await handlers[JOB_NAMES.syncNp]();
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      level: 'warn',
      skipped: 'no carrier API key',
    });
  });
});
