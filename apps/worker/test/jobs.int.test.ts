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

import { DEAD_LETTER_QUEUE, registerWorkers, startBoss } from '../src/boss.ts';
import { handleOrderCreated, OrderEmailError } from '../src/email/order-created.ts';
import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { createJobHandlers, JOB_NAMES, registerJobs } from '../src/jobs.ts';
import { AlertUndeliveredError, createMessageSender, UnhandledTopicError } from '../src/router.ts';
import { OUTBOX_TOPICS } from '../src/boss.ts';

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

async function placeOrder(
  name: string,
  over: { locale?: 'uk' | 'en'; name?: string; quantity?: number; promo?: string } = {},
) {
  await app.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token(name), variantId, quantity: over.quantity ?? 1 });
  });
  const intent = await app.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token(name) }),
  );
  await app.db.transaction(async (tx) => {
    await quoteCheckout(tx, {
      cartToken: token(name),
      intentId: intent.intentId,
      delivery: 'pickup',
      promoCode: over.promo ?? null,
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
        promoCode: over.promo ?? null,
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

  it('an order cancelled before the job ran gets no "thank you"', async () => {
    const placed = await placeOrder('mail-cancelled');
    await app.db.execute(sql`UPDATE orders SET status = 'cancelled' WHERE id = ${placed.orderId}`);
    const email = new Recorder();
    await handleOrderCreated(
      { reader: app.db, sender: email, siteUrl: 'https://shop.example' },
      { dedupKey: 'k', payload: { orderId: placed.orderId } },
    );
    expect(email.sent).toHaveLength(0);
  });

  it('with a promo the lines, the items row, the discount and the total tell one story', async () => {
    await app.db.execute(
      sql`INSERT INTO promo_codes (code, type, value) VALUES ('HUNDRED', 'fixed', 10000)`,
    );
    const placed = await placeOrder('mail-promo', { quantity: 2, promo: 'HUNDRED' });
    await app.db.execute(
      sql`UPDATE orders SET adjustment_total = 500, total = total + 500 WHERE id = ${placed.orderId}`,
    );
    const email = new Recorder();
    await handleOrderCreated(
      { reader: app.db, sender: email, siteUrl: 'https://shop.example/' },
      { dedupKey: 'k', payload: { orderId: placed.orderId } },
    );
    const text = email.sent[0]?.text ?? '';
    const nbsp = (value: string): string => value.replace(/\s/g, ' ');
    const rows = nbsp(text);
    // 1299.00 x 2 = 2598.00 gross; discount 100.00; adjustment 5.00; total 2503.00.
    expect(rows).toMatch(/x 2: 2 598,00/);
    expect(rows).toMatch(/Товари: 2 598,00/);
    expect(rows).toMatch(/Знижка: -100,00/);
    expect(rows).toMatch(/Доставка: 0,00/);
    expect(rows).toMatch(/Коригування: 5,00/);
    expect(rows).toMatch(/Разом: 2 503,00/);
    // A trailing slash on the site address must not double up in the link.
    expect(text).toContain('https://shop.example/order/track');
    expect(text).not.toContain('example//order');
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
  it('every outbox topic is handled or fails visibly: none is consumed and forgotten', async () => {
    const sender = createMessageSender({
      reader: app.db,
      email: new Recorder(),
      siteUrl: 'https://shop.example',
      fiscal: null,
      log: () => undefined,
    });
    // Topics that must fail visibly (and reach the dead-letter queue): money alerts have no channel
    // yet (Q15), and the fiscal job has no provider until the Checkbox account exists (Q3).
    const failing = new Set([
      'fiscal.issue-receipt',
      'alert.fiscal-failed',
      'alert.attempt-unresolved',
      'alert.late-payment',
      'alert.double-payment',
      'alert.payment-mismatch',
      'alert.refund-due',
      'alert.refund-unresolved',
      'alert.waybill-for-cancelled-order',
    ]);
    for (const topic of OUTBOX_TOPICS) {
      const outcome = await sender
        .send({
          idempotencyKey: 'k',
          topic,
          payload: { orderId: '0193f0a4-7c3e-7000-8000-000000000001' },
        })
        .then(
          () => 'handled',
          (error: unknown) => (error instanceof Error ? error.name : 'other'),
        );
      expect(
        failing.has(topic)
          ? outcome !== 'handled'
          : // A payload that is not the topic's own shape is a VISIBLE failure (a named error), never a silent drop.
            ['handled', 'OrderEmailError', 'AccountEmailError', 'BackInStockEmailError'].includes(
              outcome,
            ),
        topic,
      ).toBe(true);
    }
  });

  it('routes the order email, logs an alert with ids only, and fails an unknown topic loudly', async () => {
    const placed = await placeOrder('route1');
    const email = new Recorder();
    const logs: string[] = [];
    const sender = createMessageSender({
      reader: app.db,
      email,
      siteUrl: 'https://shop.example',
      fiscal: null,
      log: (l) => logs.push(l),
    });
    await sender.send({
      idempotencyKey: 'a',
      topic: 'email.order-created',
      payload: { orderId: placed.orderId },
    });
    expect(email.sent).toHaveLength(2);
    await expect(
      sender.send({
        idempotencyKey: 'b',
        topic: 'alert.late-payment',
        payload: { orderId: placed.orderId, email: 'x@example.com' },
      }),
    ).rejects.toBeInstanceOf(AlertUndeliveredError);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(placed.orderId);
    expect(logs[0]).not.toContain('x@example.com');
    await expect(
      sender.send({ idempotencyKey: 'c', topic: 'email.no-such-topic', payload: {} }),
    ).rejects.toBeInstanceOf(UnhandledTopicError);
  });
});

describe('an alert on a real pg-boss', () => {
  it('is logged and fails into the dead-letter queue, never completed', async () => {
    const boss = await startBoss(testDb.bossUrl, {
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
    });
    try {
      const logs: string[] = [];
      const sender = createMessageSender({
        reader: app.db,
        email: new Recorder(),
        siteUrl: 'https://shop.example',
        fiscal: null,
        log: (l) => logs.push(l),
      });
      await registerWorkers(boss, sender, 1);
      await boss.send('alert.refund-due', {
        dedupKey: 'refund-due:x',
        topic: 'alert.refund-due',
        payload: { orderId: '0193f0a4-7c3e-7000-8000-000000000001' },
      });
      let dead = 0;
      for (let i = 0; i < 80 && dead === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        dead = (await boss.findJobs(DEAD_LETTER_QUEUE, { limit: 5 })).length;
      }
      expect(dead).toBe(1);
      expect(logs.some((l) => l.includes('alert.refund-due'))).toBe(true);
    } finally {
      await boss.stop({ graceful: false });
    }
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
      createJobHandlers({ db: app.db, directory: null, providers: {}, log: (l) => logs.push(l) }),
      { expiry: true },
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

  it('a counter drift during expiry fails the job so it reaches the dead-letter queue', async () => {
    await placeOrder('job-drift');
    await app.db.execute(
      sql`UPDATE stock_reservations SET expires_at = now() - interval '1 minute'`,
    );
    await app.db.execute(sql`UPDATE product_variants SET reserved_quantity = 0`);
    const logs: string[] = [];
    const handlers = createJobHandlers({
      db: app.db,
      directory: null,
      providers: {},
      log: (l) => logs.push(l),
    });
    await expect(handlers[JOB_NAMES.releaseExpired]()).rejects.toThrow('stock counter drift');
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ level: 'error', failed: 1 });
  });

  it('the schedules exist with the Kyiv timezone, one per job', async () => {
    await registerJobs(
      boss,
      createJobHandlers({ db: app.db, directory: null, providers: {}, log: () => undefined }),
    );
    const schedules = await boss.getSchedules();
    // Since phase 3 the expiry job ships with the reconciliation it depends on (Q27).
    expect(schedules.map((s) => s.name).sort()).toEqual(
      [
        JOB_NAMES.releaseExpired,
        JOB_NAMES.reconcileStock,
        JOB_NAMES.syncNp,
        JOB_NAMES.reconcileOpen,
        JOB_NAMES.cleanQuarantine,
        JOB_NAMES.reconcileFiscal,
        JOB_NAMES.sweepRefunds,
        JOB_NAMES.purgePendingAccounts,
        JOB_NAMES.notifyRestocked,
        JOB_NAMES.cleanViews,
      ].sort(),
    );
    expect(schedules.every((s) => s.timezone === 'Europe/Kyiv')).toBe(true);
  });

  it('the views cleanup removes product views older than 90 days and keeps newer ones', async () => {
    const [product] = (await app.db.execute<{ id: string }>(sql`SELECT id FROM products LIMIT 1`))
      .rows;
    const productId = product?.id ?? '';
    await app.db.execute(sql`INSERT INTO product_views (product_id, session_hash, viewed_on) VALUES
      (${productId}::uuid, ${'a'.repeat(64)}, (now() AT TIME ZONE 'UTC')::date - 120),
      (${productId}::uuid, ${'b'.repeat(64)}, (now() AT TIME ZONE 'UTC')::date - 5)`);
    const logs: string[] = [];
    const handlers = createJobHandlers({
      db: app.db,
      directory: null,
      providers: {},
      log: (line) => logs.push(line),
    });
    await handlers[JOB_NAMES.cleanViews]();
    const left = await app.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM product_views`,
    );
    expect(left.rows[0]?.n).toBe(1);
    expect(logs.join('')).toContain('"removed":1');
  });

  it('the reconcile job reports a drifted counter at error level, ids only', async () => {
    await placeOrder('job2');
    await app.db.execute(
      sql`UPDATE product_variants SET reserved_quantity = reserved_quantity + 3`,
    );
    const logs: string[] = [];
    const handlers = createJobHandlers({
      db: app.db,
      directory: null,
      providers: {},
      log: (l) => logs.push(l),
    });
    await expect(handlers[JOB_NAMES.reconcileStock]()).rejects.toThrow('drifted');
    const line = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', scope: JOB_NAMES.reconcileStock, drifted: 2 });
  });

  it('the sync job without a carrier key skips with a warning instead of failing', async () => {
    const logs: string[] = [];
    const handlers = createJobHandlers({
      db: app.db,
      directory: null,
      providers: {},
      log: (l) => logs.push(l),
    });
    await handlers[JOB_NAMES.syncNp]();
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      level: 'warn',
      skipped: 'no carrier API key',
    });
  });
});
