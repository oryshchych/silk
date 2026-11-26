/**
 * `stock.notify-back-in-stock` and `email.back-in-stock` through the real job handler and message
 * router on Postgres: a restock queues the mail once, the mail carries the product link and a working
 * unsubscribe link, an alert removed meanwhile sends nothing, a missing secret fails the job.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readUnsubscribeToken, subscribeStockAlert } from '@store/core/account-alerts';
import { createDb, type DbHandle } from '@store/db/client';
import { customers, outbox } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { createJobHandlers, JOB_NAMES } from '../src/jobs.ts';
import type { EmailMessage, EmailSender } from '../src/email/resend.ts';
import { renderBackInStock } from '../src/email/back-in-stock.ts';
import { createMessageSender } from '../src/router.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
let testDb: TestDatabase;
let app: DbHandle;
let variant = '';
let alertId = '';

class Recorder implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

beforeEach(async () => {
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 3 });
  const fixture = await app.db.transaction(async (tx) => await seedMoneySkeleton(tx));
  variant = fixture.variantIds[0];
  await app.db.execute(
    sql`UPDATE products SET is_active = true, published_at = now() - interval '1 day', name_en = 'Aurora <b>bra</b>' WHERE id = ${fixture.productId}`,
  );
  await app.db.execute(sql`UPDATE categories SET is_active = true`);
  await app.db.execute(sql`UPDATE product_variants SET stock_quantity = 0 WHERE id = ${variant}`);
  const [user] = await app.db
    .execute<{ id: string }>(
      sql`INSERT INTO auth_users (email, email_verified_at) VALUES ('Fan@Example.test', now()) RETURNING id`,
    )
    .then((r) => r.rows);
  const [customer] = await app.db
    .insert(customers)
    .values({ email: 'fan@example.test', userId: user?.id ?? null, locale: 'en' })
    .returning({ id: customers.id });
  alertId = await app.db.transaction(
    async (tx) =>
      await subscribeStockAlert(
        tx,
        {
          customerId: customer?.id ?? '',
          userId: user?.id ?? '',
          email: 'fan@example.test',
          locale: 'en',
          ip: null,
        },
        variant,
      ),
  );
});
afterEach(async () => {
  await app.close();
  await testDb.drop();
});

const handlers = () =>
  createJobHandlers({ db: app.db, directory: null, providers: {}, log: () => undefined });
const sender = (email: Recorder, ...secret: [] | [string | undefined]) =>
  createMessageSender({
    reader: app.db,
    email,
    siteUrl: 'https://shop.example/',
    authSecret: secret.length === 0 ? SECRET : secret[0],
    fiscal: null,
    log: () => undefined,
  });
const queuedMessage = async () => {
  const [row] = await app.db.select().from(outbox).where(eq(outbox.topic, 'email.back-in-stock'));
  return row === undefined
    ? null
    : { topic: row.topic, idempotencyKey: row.dedupKey ?? 'k', payload: row.payload };
};

describe('the restock job and the mail', () => {
  it('queues nothing while the size is out, one message after the restock, none on the next run', async () => {
    await handlers()[JOB_NAMES.notifyRestocked]();
    expect(await queuedMessage()).toBeNull();
    await app.db.execute(sql`UPDATE product_variants SET stock_quantity = 7 WHERE id = ${variant}`);
    await handlers()[JOB_NAMES.notifyRestocked]();
    await handlers()[JOB_NAMES.notifyRestocked]();
    expect(
      await app.db.select().from(outbox).where(eq(outbox.topic, 'email.back-in-stock')),
    ).toHaveLength(1);
  });

  it('mails the product link and a working unsubscribe link, in the stored language, with the name escaped', async () => {
    await app.db.execute(sql`UPDATE product_variants SET stock_quantity = 7 WHERE id = ${variant}`);
    await handlers()[JOB_NAMES.notifyRestocked]();
    const message = await queuedMessage();
    if (message === null) throw new Error('nothing queued');
    const email = new Recorder();
    await sender(email).send(message);
    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0];
    expect(sent?.to).toBe('fan@example.test');
    expect(sent?.subject).toContain('is back in stock');
    expect(sent?.text).toMatch(/https:\/\/shop\.example\/en\/product\//);
    const token = /unsubscribe\?t=([^\s]+)/.exec(sent?.text ?? '')?.[1];
    expect(readUnsubscribeToken(SECRET, decodeURIComponent(token ?? ''))).toBe(alertId);
    expect(sent?.html).not.toContain('<b>bra</b>');
    expect(sent?.idempotencyKey).toBe(`${message.idempotencyKey}:customer`);
  });

  it('sends nothing when the alert was removed meanwhile; fails (visibly) without a secret or with a bad payload', async () => {
    await app.db.execute(sql`UPDATE product_variants SET stock_quantity = 7 WHERE id = ${variant}`);
    await handlers()[JOB_NAMES.notifyRestocked]();
    const message = await queuedMessage();
    if (message === null) throw new Error('nothing queued');
    const email = new Recorder();
    await expect(sender(email, undefined).send(message)).rejects.toThrow();
    await expect(sender(email).send({ ...message, payload: { alertId: 'x' } })).rejects.toThrow();
    await expect(
      sender(email).send({ ...message, payload: { alertId, email: 'a@b.c' } }),
    ).rejects.toThrow();
    await app.db.execute(sql`DELETE FROM stock_notifications`);
    await sender(email).send(message);
    expect(email.sent).toHaveLength(0);
  });

  it('renders Ukrainian copy', () => {
    const rendered = renderBackInStock({
      locale: 'uk',
      product: 'Аврора',
      size: '75B',
      productUrl: 'https://x/p',
      unsubscribeUrl: 'https://x/u',
    });
    expect(rendered.subject).toContain('знову в наявності');
    expect(rendered.text).toContain('75B');
  });
});
