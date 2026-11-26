/**
 * The `refunds.sweep` job through the real handler map: it is scheduled, it sends a refund nobody
 * sent (real MonoProvider over a socket against the local fake) and it raises one alert for an
 * unknown one without calling the provider.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setCartItem, startCheckout } from '@store/core/cart';
import { createOrder } from '@store/core/orders';
import { requestRefund } from '@store/core/refunds';
import { createDb, type DbHandle } from '@store/db/client';
import { settings } from '@store/db/schema';
import { seedMoneySkeleton } from '@store/db/seed/money-skeleton';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import { MonoProvider } from '@store/payments/mono';
import { startFakeMono, type FakeMono } from '@store/payments/test/fake-mono';
import { money } from '@store/shared/money';

import { OUTBOX_TOPICS } from '../src/boss.ts';
import { createJobHandlers, JOB_NAMES } from '../src/jobs.ts';

let fake: FakeMono;
let mono: MonoProvider;
let testDb: TestDatabase;
let app: DbHandle;
let orderId = '';
let attemptId = '';

beforeAll(async () => {
  fake = await startFakeMono();
  mono = new MonoProvider({
    pageHosts: ['pay.example'],
    baseUrl: fake.baseUrl,
    token: 't',
    timeoutMs: 300,
  });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  fake.requests.length = 0;
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 3 });
  const fixture = await app.db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: 'payment_providers', value: { mono: true, cod: true } });
    return await seedMoneySkeleton(tx);
  });
  const token = 'tok-sweep-job-cart-x'.padEnd(20, 'x');
  await app.db.transaction(async (tx) => {
    await setCartItem(tx, { cartToken: token, variantId: fixture.variantIds[0], quantity: 1 });
  });
  const intent = await app.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: token }),
  );
  const placed = await app.db.transaction(
    async (tx) =>
      await createOrder(tx, {
        intentId: intent.intentId,
        ownerToken: token,
        contact: { email: 'b@example.com', phone: '+380501234567', name: 'Іра Петренко' },
        delivery: { method: 'pickup' },
        paymentProvider: 'mono',
        promoCode: null,
        locale: 'uk',
        allowUnquoted: true,
        termsAccepted: true,
      }),
  );
  orderId = placed.orderId;
  attemptId =
    (
      await app.db.execute<{ id: string }>(
        sql`INSERT INTO payment_attempts (order_id, attempt_number, provider, amount, state, status, captured_amount, external_id)
            SELECT id, 1, 'mono', total, 'succeeded', 'paid', total, 'inv-job' FROM orders WHERE id = ${orderId} RETURNING id`,
      )
    ).rows[0]?.id ?? '';
  await app.db.execute(
    sql`UPDATE orders SET payment_status = 'paid', captured_total = total WHERE id = ${orderId}`,
  );
});
afterEach(async () => {
  await app.close();
  await testDb.drop();
});

const handlers = () =>
  createJobHandlers({ db: app.db, directory: null, providers: { mono }, log: () => undefined });
const reserve = async (amount: number) =>
  (
    await app.db.transaction(
      async (tx) =>
        await requestRefund(tx, {
          orderId,
          attemptId,
          amount: money(amount),
          reason: 'job test',
          initiatedBy: null,
          providers: { mono },
        }),
    )
  ).operationId;

describe('refunds.sweep', () => {
  it('is a named job', () => {
    expect(JOB_NAMES.sweepRefunds).toBe('refunds.sweep');
  });

  it('sends a refund nobody sent, once, and leaves a fresh one', async () => {
    const old = await reserve(10_000);
    const fresh = await reserve(5_000);
    await app.db.execute(
      sql`UPDATE refund_operations SET created_at = now() - interval '30 minutes' WHERE id = ${old}`,
    );
    await handlers()[JOB_NAMES.sweepRefunds]();
    await handlers()[JOB_NAMES.sweepRefunds]();
    const states = await app.db.execute<{ id: string; state: string }>(
      sql`SELECT id, state FROM refund_operations`,
    );
    expect(states.rows.find((r) => r.id === old)?.state).toBe('succeeded');
    expect(states.rows.find((r) => r.id === fresh)?.state).toBe('pending');
    expect(fake.requests.filter((r) => r.url.includes('cancel'))).toHaveLength(1);
  });

  it('an unknown refund older than an hour gives one alert and no provider call', async () => {
    const op = await reserve(10_000);
    await app.db.execute(
      sql`UPDATE refund_operations SET state = 'unknown', created_at = now() - interval '3 hours' WHERE id = ${op}`,
    );
    await handlers()[JOB_NAMES.sweepRefunds]();
    await handlers()[JOB_NAMES.sweepRefunds]();
    expect(
      (await app.db.execute(sql`SELECT 1 FROM outbox WHERE topic = 'alert.refund-unresolved'`))
        .rows,
    ).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
  });
});

/** Every `.ts` source file under a directory, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.includes('.test.') ? [path] : [];
  });
}

describe('the outbox topics', () => {
  it('every topic the core writes has a queue: a topic without one ends stuck and nobody is told', () => {
    const written = new Set<string>();
    for (const file of sources(join(import.meta.dirname, '../../../packages/core/src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/topic:\s*'([a-z]+\.[a-z-]+)'/g)) {
        if (match[1] !== undefined) written.add(match[1]);
      }
    }
    expect(written.size).toBeGreaterThan(8);
    const queues: readonly string[] = OUTBOX_TOPICS;
    expect([...written].filter((topic) => !queues.includes(topic))).toEqual([]);
  });

  it('the sweep job logs counts only', async () => {
    const op = await reserve(10_000);
    await app.db.execute(
      sql`UPDATE refund_operations SET state = 'unknown', created_at = now() - interval '3 hours' WHERE id = ${op}`,
    );
    const lines: string[] = [];
    await createJobHandlers({
      db: app.db,
      directory: null,
      providers: { mono },
      log: (line) => lines.push(line),
    })[JOB_NAMES.sweepRefunds]();
    expect(lines).toHaveLength(1);
    expect(Object.keys(JSON.parse(lines[0] ?? '{}') as object).sort()).toEqual([
      'alerted',
      'failed',
      'level',
      'scope',
      'sent',
    ]);
  });
});
