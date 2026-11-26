/**
 * The three customer mail topics through the REAL chain on Postgres and a real pg-boss: the domain writes
 * the outbox row, the relay publishes it, a worker consumes it with the real message router, and the
 * mail is sent. A topic without a queue ends `stuck` (phase 5 lesson), so each topic is proven DELIVERED,
 * not just handled by calling its handler. The domain functions write the rows: nothing is hand-made.
 */
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { subscribeStockAlert, notifyRestocked } from '@store/core/account-alerts';
import {
  completeWithToken,
  requestPasswordReset,
  requestRegistration,
} from '@store/core/customer-auth';
import { createDb, type DbHandle } from '@store/db/client';
import { customers } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { bossPublisher, registerWorkers, startBoss } from '../src/boss.ts';
import { relayOutbox } from '../src/relay.ts';
import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { buildEmailToken } from '@store/core/customer-token';
import { createMessageSender } from '../src/router.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
const client = { ip: null, userAgent: null };
let testDb: TestDatabase;
let app: DbHandle;
let boss: PgBoss;

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
});
afterEach(async () => {
  await boss.stop({ graceful: false });
  await app.close();
  await testDb.drop();
});

async function waitFor(check: () => boolean, ms = 25_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('customer mail topics are delivered, not stuck', () => {
  it('a registration link, a password-reset link and a back-in-stock mail all reach the sender', async () => {
    // Registration: the domain writes email.account-verify.
    await app.db.transaction(async (tx) => {
      await requestRegistration(tx, { email: 'new@example.test', locale: 'uk', client });
    });
    // Reset: a verified account asks for a link (email.password-reset).
    const [user] = await app.db
      .execute<{ id: string }>(
        sql`INSERT INTO auth_users (email, email_verified_at) VALUES ('old@example.test', now()) RETURNING id`,
      )
      .then((r) => r.rows);
    const [customer] = await app.db
      .insert(customers)
      .values({ email: 'old@example.test', userId: user?.id ?? null })
      .returning({ id: customers.id });
    await app.db.transaction(async (tx) => {
      await requestPasswordReset(tx, { email: 'old@example.test', locale: 'uk', client });
    });
    // Back in stock: an alert on a sold-out size, then a restock.
    const fixture = await app.db.transaction(async (tx) => await seedMoneySkeleton(tx));
    await app.db.execute(
      sql`UPDATE products SET is_active = true, published_at = now() - interval '1 day' WHERE id = ${fixture.productId}`,
    );
    await app.db.execute(sql`UPDATE categories SET is_active = true`);
    await app.db.execute(
      sql`UPDATE product_variants SET stock_quantity = 0 WHERE id = ${fixture.variantIds[0]}`,
    );
    await app.db.transaction(
      async (tx) =>
        await subscribeStockAlert(
          tx,
          {
            customerId: customer?.id ?? '',
            userId: user?.id ?? '',
            email: 'old@example.test',
            locale: 'uk',
            ip: null,
          },
          fixture.variantIds[0],
        ),
    );
    await app.db.execute(
      sql`UPDATE product_variants SET stock_quantity = 5 WHERE id = ${fixture.variantIds[0]}`,
    );
    await app.db.transaction(async (tx) => await notifyRestocked(tx));

    const email = new Recorder();
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
    const result = await relayOutbox(app.db, bossPublisher(boss));
    expect(result).toMatchObject({ failed: 0, stuck: 0 });
    expect(result.published).toBeGreaterThanOrEqual(3);

    await waitFor(() => email.sent.length >= 3);
    const subjects = email.sent.map((m) => m.subject).join(' | ');
    expect(email.sent, subjects).toHaveLength(3);
    // The reset mail for an existing account and the registration mail carry working links.
    const links = email.sent
      .map((m) => /account\/set-password\?t=([^\s]+)/.exec(m.text)?.[1])
      .filter((x) => x !== undefined);
    expect(links).toHaveLength(2);
    expect(email.sent.some((m) => m.text.includes('/unsubscribe?t='))).toBe(true);
    const out = await app.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`,
    );
    expect(out.rows[0]?.n).toBe(0);
    const dead = await app.db
      .execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'outbox.dead'`,
      )
      .catch(() => null);
    expect(dead === null ? 0 : dead.rows[0]?.n).toBe(0);
    // The link of the registration mail really completes the registration (the whole chain works).
    const first = decodeURIComponent(links[0] ?? '');
    expect(first.length).toBeGreaterThan(40);
    expect(buildEmailToken(SECRET, first.split('.')[0] ?? '')).toBe(first);
    const done = await app.db.transaction(
      async (tx) =>
        await completeWithToken(
          tx,
          { secret: SECRET },
          { token: first, password: 'a-long-password-77', client },
        ),
    );
    expect(done.ok).toBe(true);
  });
});
