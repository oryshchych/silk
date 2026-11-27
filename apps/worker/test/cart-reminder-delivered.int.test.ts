/**
 * `email.cart-reminder` through the REAL chain on Postgres and a real pg-boss: the cron job's claim writes the
 * outbox row, the relay publishes it, a worker consumes it with the real router, the mail reaches the sender.
 * A topic without a queue ends `stuck` (phase 5 lesson), so delivery is proven, not just the handler.
 * Also the criteria: the reminder goes EXACTLY ONCE (a second cron run and a second relay send nothing more)
 * and NOT when an order was placed.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildMarketingUnsubscribeToken,
  readMarketingUnsubscribeToken,
} from '@store/core/marketing';
import { createDb, type DbHandle } from '@store/db/client';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { bossPublisher, OUTBOX_TOPICS, registerWorkers, startBoss } from '../src/boss.ts';
import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { createJobHandlers, JOB_NAMES } from '../src/jobs.ts';
import { relayOutbox } from '../src/relay.ts';
import { createMessageSender } from '../src/router.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
let testDb: TestDatabase;
let app: DbHandle;
let boss: PgBoss;
let variantId = '';

class Recorder implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

beforeEach(async () => {
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 4 });
  boss = await startBoss(testDb.bossUrl, { retryLimit: 1, retryDelay: 0, retryBackoff: false });
  const fixture = await app.db.transaction(async (tx) => await seedMoneySkeleton(tx));
  variantId = fixture.variantIds[0];
  await app.db.execute(
    sql`UPDATE products SET is_active = true, published_at = now() - interval '1 day'`,
  );
  await app.db.execute(sql`UPDATE product_variants SET is_active = true, stock_quantity = 20`);
});
afterEach(async () => {
  await boss.stop({ graceful: false });
  await app.close();
  await testDb.drop();
});

async function abandonedCart(email: string): Promise<{ cartId: string; subscriberId: string }> {
  await app.db.execute(
    sql`INSERT INTO customers (email, accepts_marketing, locale) VALUES (${email}, true, 'en')`,
  );
  const sub = await app.db.execute<{ id: string }>(
    sql`INSERT INTO newsletter_subscribers (email, locale, source, confirmed_at)
        VALUES (${email}, 'en', 'account', now()) RETURNING id`,
  );
  const cart = await app.db.execute<{ id: string }>(
    sql`INSERT INTO carts (token, customer_id)
        SELECT ${`tok-${email}`.padEnd(32, 'x')}, id FROM customers WHERE email = ${email} RETURNING id`,
  );
  const cartId = cart.rows[0]?.id ?? '';
  await app.db.execute(
    sql`INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES (${cartId}::uuid, ${variantId}::uuid, 2)`,
  );
  const owner = new pg.Client({ connectionString: testDb.migrateUrl });
  await owner.connect();
  try {
    await owner.query('ALTER TABLE carts DISABLE TRIGGER carts_touch_updated_at');
    await owner.query(
      `UPDATE carts SET updated_at = now() - interval '3 hours' WHERE id = $1::uuid`,
      [cartId],
    );
    await owner.query('ALTER TABLE carts ENABLE TRIGGER carts_touch_updated_at');
  } finally {
    await owner.end();
  }
  return { cartId, subscriberId: sub.rows[0]?.id ?? '' };
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const startWorker = async (email: Recorder): Promise<void> => {
  await registerWorkers(
    boss,
    createMessageSender({
      reader: app.db,
      email,
      siteUrl: 'https://shop.example',
      authSecret: SECRET,
      fiscal: null,
      log: () => undefined,
    }),
    0.5,
  );
};
const cron = async (): Promise<void> => {
  await createJobHandlers({ db: app.db, directory: null, providers: {}, log: () => undefined })[
    JOB_NAMES.remindAbandonedCarts
  ]();
};

describe('the cart reminder is delivered, once, and not after an order', () => {
  it('the topic has a queue', () => {
    expect(OUTBOX_TOPICS).toContain('email.cart-reminder');
  });

  it('reaches the sender once with a working unsubscribe link, however often the job runs', async () => {
    const { subscriberId } = await abandonedCart('buyer@example.test');
    const email = new Recorder();
    await startWorker(email);
    await cron();
    expect(await relayOutbox(app.db, bossPublisher(boss))).toMatchObject({ failed: 0, stuck: 0 });
    await waitFor(() => email.sent.length >= 1);
    expect(email.sent).toHaveLength(1);
    const mail = email.sent[0];
    expect(mail?.to).toBe('buyer@example.test');
    expect(mail?.subject).toBe('You left items in your cart');
    expect(mail?.text).toContain('https://shop.example/en/cart');
    const link = /unsubscribe\/marketing\?t=([^\s]+)/.exec(mail?.text ?? '')?.[1] ?? '';
    expect(readMarketingUnsubscribeToken(SECRET, decodeURIComponent(link))).toBe(subscriberId);
    expect(buildMarketingUnsubscribeToken(SECRET, subscriberId)).toBe(decodeURIComponent(link));

    // The next cron ticks and relay rounds send nothing more.
    await cron();
    await cron();
    await relayOutbox(app.db, bossPublisher(boss));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(email.sent).toHaveLength(1);
    const pending = await app.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`,
    );
    expect(pending.rows[0]?.n).toBe(0);
  });

  it('sends nothing when the customer placed an order between the claim and the send', async () => {
    const { cartId } = await abandonedCart('orders@example.test');
    const email = new Recorder();
    await startWorker(email);
    await cron();
    await app.db.execute(
      sql`INSERT INTO orders (order_number, customer_id, customer_email, customer_name, customer_phone, delivery_method,
            payment_provider, subtotal, total)
          SELECT 'T-PLACED', c.customer_id, 'orders@example.test', 'B', '+380501112233', 'pickup', 'cod', 100, 100
            FROM carts c WHERE c.id = ${cartId}::uuid`,
    );
    await relayOutbox(app.db, bossPublisher(boss));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(email.sent).toHaveLength(0);
    const dead = await app.db
      .execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'outbox.dead'`,
      )
      .catch(() => null);
    expect(dead === null ? 0 : dead.rows[0]?.n).toBe(0);
  });
});
