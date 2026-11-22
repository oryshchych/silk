/**
 * Outbox relay on a real Postgres with a real pg-boss (phase 0.5 criterion 8).
 * A "process crash" is simulated at each interesting point; after the restart
 * the message must go out exactly once.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import { Barrier } from './barrier.ts';

import { bossPublisher, DEAD_LETTER_QUEUE, registerWorkers, startBoss } from '../src/boss.ts';
import { deliverJob, type MessageSender, type OutboundMessage } from '../src/deliver.ts';
import { relayOutbox, type QueuePublisher, type TransactionRunner } from '../src/relay.ts';

const QUEUE = 'email.order-created';

let testDb: TestDatabase;
let app: DbHandle;
let boss: PgBoss;
let bossSql: pg.Client;
const extraHandles: DbHandle[] = [];
const extraBoss: PgBoss[] = [];

beforeEach(async () => {
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 2 });
  // retryLimit 1: one retry, then the dead-letter queue. Queue options are fixed by the first
  // createQueue, so every test shares this tuning.
  boss = await startBoss(testDb.bossUrl, { retryLimit: 1, retryDelay: 0, retryBackoff: false });
  bossSql = new pg.Client({ connectionString: testDb.bossUrl });
  await bossSql.connect();
});

afterEach(async () => {
  await bossSql.end();
  for (const extra of extraBoss.splice(0)) await extra.stop({ graceful: false });
  await boss.stop({ graceful: false });
  for (const handle of extraHandles.splice(0)) await handle.close();
  await app.close();
  await testDb.drop();
});

async function addOutbox(dedupKey: string, topic = QUEUE): Promise<string> {
  const result = await app.db.execute<{ id: string }>(
    sql`INSERT INTO outbox (topic, payload, dedup_key)
        VALUES (${topic}, ${JSON.stringify({ orderId: dedupKey })}::jsonb, ${dedupKey}) RETURNING id`,
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('outbox insert returned no row');
  return id;
}

const publisherFor = (instance: PgBoss): QueuePublisher => bossPublisher(instance);

/** The real publisher with some behaviour replaced, for failure injection. */
const withOverrides = (instance: PgBoss, overrides: Partial<QueuePublisher>): QueuePublisher => ({
  ...bossPublisher(instance),
  ...overrides,
});

const connectionError = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED postgres://boss:secret@10.0.0.5/store'), {
    code: 'ECONNREFUSED',
  });

async function jobCount(): Promise<number> {
  const result = await bossSql.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1',
    [QUEUE],
  );
  return result.rows[0]?.n ?? -1;
}

async function unpublished(): Promise<number> {
  const result = await app.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`,
  );
  return result.rows[0]?.n ?? -1;
}

/** A mail provider that honours Idempotency-Key: the second send with a key is a no-op. */
class FakeProvider implements MessageSender {
  readonly seen = new Set<string>();
  readonly delivered: OutboundMessage[] = [];
  calls = 0;

  send(message: OutboundMessage): Promise<void> {
    this.calls += 1;
    if (!this.seen.has(message.idempotencyKey)) {
      this.seen.add(message.idempotencyKey);
      this.delivered.push(message);
    }
    return Promise.resolve();
  }
}

/** Fetch, deliver and complete every job currently queued, like a worker would. */
async function consumeAll(instance: PgBoss, sender: MessageSender): Promise<number> {
  let handled = 0;
  for (;;) {
    const jobs = await instance.fetch<{ dedupKey: string; topic: string; payload: unknown }>(
      QUEUE,
      { batchSize: 10 },
    );
    if (jobs.length === 0) return handled;
    for (const job of jobs) {
      await deliverJob(job, sender);
      await instance.complete(QUEUE, job.id);
      handled += 1;
    }
  }
}

describe('criterion 8: a crash between the commit and the publication', () => {
  it('the process died after taking the row but before the send: after the restart the mail goes out once', async () => {
    await addOutbox('order-created:o1');
    const crashing: TransactionRunner = {
      transaction: async () =>
        await app.db.transaction(async (tx) => {
          // the relay's own SELECT ... FOR UPDATE ran, then the process died before any send
          await tx.execute(sql`SELECT id FROM outbox WHERE published_at IS NULL FOR UPDATE`);
          throw new Error('process died before the send');
        }),
    };
    await expect(relayOutbox(crashing, publisherFor(boss))).rejects.toThrow('died');
    expect(await unpublished()).toBe(1);
    expect(await jobCount()).toBe(0);

    const restarted = await startBoss(testDb.bossUrl);
    extraBoss.push(restarted);
    expect(await relayOutbox(app.db, publisherFor(restarted))).toMatchObject({
      published: 1,
      failed: 0,
    });
    const provider = new FakeProvider();
    expect(await consumeAll(restarted, provider)).toBe(1);
    expect(provider.delivered).toHaveLength(1);
    expect(await unpublished()).toBe(0);
    expect(await relayOutbox(app.db, publisherFor(restarted))).toMatchObject({ published: 0 });
  });

  it('the process died after the send but before the commit: the re-send collapses into one job', async () => {
    await addOutbox('order-created:o2');
    const crashing: TransactionRunner = {
      transaction: async (fn) =>
        await app.db.transaction(async (tx) => {
          await fn(tx);
          throw new Error('process died before the commit');
        }),
    };
    await expect(relayOutbox(crashing, publisherFor(boss))).rejects.toThrow('died');
    expect(await unpublished()).toBe(1); // the mark was rolled back with the transaction
    expect(await jobCount()).toBe(1); // but the job reached pg-boss

    const restarted = await startBoss(testDb.bossUrl);
    extraBoss.push(restarted);
    expect(await relayOutbox(app.db, publisherFor(restarted))).toMatchObject({
      published: 1,
      failed: 0,
    });
    expect(await jobCount()).toBe(1); // collapsed by the singleton key, not duplicated
    expect(await unpublished()).toBe(0);

    const provider = new FakeProvider();
    expect(await consumeAll(restarted, provider)).toBe(1);
    expect(provider.delivered).toHaveLength(1);
  });

  it('the first job already finished before the re-send: the provider idempotency key keeps it to one mail', async () => {
    await addOutbox('order-created:o3');
    const crashing: TransactionRunner = {
      transaction: async (fn) =>
        await app.db.transaction(async (tx) => {
          await fn(tx);
          throw new Error('process died before the commit');
        }),
    };
    await expect(relayOutbox(crashing, publisherFor(boss))).rejects.toThrow('died');

    const provider = new FakeProvider();
    expect(await consumeAll(boss, provider)).toBe(1); // the consumer finished the first job
    expect(await relayOutbox(app.db, publisherFor(boss))).toMatchObject({
      published: 1,
      failed: 0,
    });
    expect(await consumeAll(boss, provider)).toBe(1); // a second job really exists now

    expect(provider.calls).toBe(2); // delivered twice by the queue...
    expect(provider.delivered).toHaveLength(1); // ...but ONE letter (idempotency key)
  });
});

describe('relay mechanics', () => {
  it('two overlapping relays on separate connections: every row sent exactly once, both made progress', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 24; n += 1) ids.push(await addOutbox(`order-created:bulk-${String(n)}`));
    const second = createDb(testDb.appUrl, { max: 2 });
    extraHandles.push(second);
    const other = await startBoss(testDb.bossUrl);
    extraBoss.push(other);

    const sends = new Map<string, number>();
    let inFlight = 0;
    let maxInFlight = 0;
    const counting = (instance: PgBoss, delayMs: number): QueuePublisher =>
      withOverrides(instance, {
        send: async (queue, data, options) => {
          const outboxId = (data as { outboxId: string }).outboxId;
          sends.set(outboxId, (sends.get(outboxId) ?? 0) + 1);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          inFlight -= 1; // keep the transactions overlapping
          return await instance.send(queue, data, options);
        },
      });
    const barrier = new Barrier(2);
    const run = async (handle: DbHandle, instance: PgBoss) => {
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await relayOutbox(handle.db, counting(instance, 30), { batchSize: 12 });
    };
    const [a, b] = await Promise.all([run(app, boss), run(second, other)]);

    // with SKIP LOCKED each relay got its own 12 rows; a blocking lock would leave one with 0
    expect(a.published).toBeGreaterThan(0);
    expect(b.published).toBeGreaterThan(0);
    expect(a.published + b.published).toBe(24);
    expect([...sends.values()].every((n) => n === 1)).toBe(true);
    expect(sends.size).toBe(24);
    // the two relays really worked at the same time (a blocking lock would serialise them)
    expect(maxInFlight).toBe(2);
    expect(await unpublished()).toBe(0);
    expect(await jobCount()).toBe(24);
  });

  it('an outage: the probe skips the tick, no lock, no send, no attempt', async () => {
    await addOutbox('order-created:probe');
    let sends = 0;
    const down = withOverrides(boss, {
      isUp: () => Promise.resolve(false),
      send: () => {
        sends += 1;
        return Promise.resolve(null);
      },
    });
    expect(await relayOutbox(app.db, down)).toMatchObject({ published: 0, skipped: true });
    expect(sends).toBe(0);
    const row = await app.db.execute<{ attempts: number }>(sql`SELECT attempts FROM outbox`);
    expect(row.rows[0]?.attempts).toBe(0);
  });

  it('the queue drops mid-batch: the batch stops at once, no attempt is burned, no raw message stored', async () => {
    for (let n = 0; n < 6; n += 1) await addOutbox(`order-created:flap-${String(n)}`);
    let calls = 0;
    const flapping = withOverrides(boss, {
      send: async (queue, data, options) => {
        calls += 1;
        if (calls > 1) throw connectionError();
        return await boss.send(queue, data, options);
      },
    });
    const result = await relayOutbox(app.db, flapping, { maxAttempts: 10 });
    expect(result).toMatchObject({ published: 1, failed: 1, stuck: 0 });
    expect(calls).toBe(2); // not one wait per remaining row
    const rows = await app.db.execute<{ attempts: number; last_error: string | null }>(
      sql`SELECT attempts, last_error FROM outbox ORDER BY created_at, id`,
    );
    expect(rows.rows.map((r) => r.attempts)).toEqual([1, 0, 0, 0, 0, 0]); // 1 = the published row
    expect(JSON.stringify(rows.rows)).not.toContain('secret');
    expect(rows.rows[1]?.last_error).toBe('Error:ECONNREFUSED');

    // flaps repeat for many ticks: healthy rows are never burnt into "stuck"
    for (let tick = 0; tick < 15; tick += 1) {
      calls = 0;
      await relayOutbox(app.db, flapping, { maxAttempts: 3 });
    }
    // the one send that gets through per tick drains the queue; nothing was burnt into "stuck"
    expect(await unpublished()).toBe(0);
    const attempts = await app.db.execute<{ max: number }>(
      sql`SELECT max(attempts)::int AS max FROM outbox`,
    );
    expect(attempts.rows[0]?.max).toBe(1);
  });

  it('three poison rows at the head do not block the healthy rows behind them, and become stuck', async () => {
    const poison: string[] = [];
    for (let n = 0; n < 3; n += 1)
      poison.push(await addOutbox(`order-created:poison-${String(n)}`));
    for (let n = 0; n < 4; n += 1) await addOutbox(`order-created:good-${String(n)}`);
    const picky = withOverrides(boss, {
      send: async (queue, data, options) => {
        if (options.singletonKey.includes('poison')) throw new Error('payload rejected');
        return await boss.send(queue, data, options);
      },
    });
    // tick 1: every healthy row is reached even though three poison rows come first
    expect(await relayOutbox(app.db, picky, { maxAttempts: 3 })).toMatchObject({
      published: 4,
      failed: 3,
      stuck: 0,
    });
    await relayOutbox(app.db, picky, { maxAttempts: 3 });
    const last = await relayOutbox(app.db, picky, { maxAttempts: 3 });
    expect(last).toMatchObject({ failed: 3, stuck: 3 }); // third failure reaches the limit
    // at the limit they are no longer retried, but still reported on every tick
    expect(await relayOutbox(app.db, picky, { maxAttempts: 3 })).toMatchObject({
      failed: 0,
      stuck: 3,
    });
    await addOutbox('order-created:late-alert', 'alert.double-payment');
    expect(await relayOutbox(app.db, picky, { maxAttempts: 3 })).toMatchObject({
      published: 1,
      stuck: 3,
    });
    const row = await app.db.execute<{ last_error: string }>(
      sql`SELECT last_error FROM outbox WHERE id = ${poison[0] ?? ''}`,
    );
    expect(row.rows[0]?.last_error).toBe('Error');
  });

  it('a topic without a queue is the row problem: it burns attempts, is reported, and does not block others', async () => {
    await addOutbox('order-created:orphan', 'no.such.queue');
    await addOutbox('order-created:fine');
    expect(await relayOutbox(app.db, publisherFor(boss), { maxAttempts: 2 })).toMatchObject({
      published: 1,
      failed: 1,
      stuck: 0,
    });
    expect(await relayOutbox(app.db, publisherFor(boss), { maxAttempts: 2 })).toMatchObject({
      failed: 1,
      stuck: 1,
    });
    expect(await relayOutbox(app.db, publisherFor(boss), { maxAttempts: 2 })).toMatchObject({
      failed: 0,
      stuck: 1,
    });
  });

  it('a send that returns null while no job exists is a lost message, never "published"', async () => {
    await addOutbox('order-created:lost');
    const lossy = withOverrides(boss, {
      send: () => Promise.resolve(null),
      hasJob: () => Promise.resolve(false),
    });
    expect(await relayOutbox(app.db, lossy, { maxAttempts: 5 })).toMatchObject({
      published: 0,
      failed: 1,
    });
    expect(await unpublished()).toBe(1);
    const row = await app.db.execute<{ attempts: number; last_error: string }>(
      sql`SELECT attempts, last_error FROM outbox`,
    );
    expect(row.rows[0]).toMatchObject({ attempts: 1, last_error: 'LostJobError' });
  });

  it('an empty dedup key never reaches an exclusive queue as an empty singleton key', async () => {
    const id = await addOutbox('placeholder');
    await app.db.execute(sql`UPDATE outbox SET dedup_key = '' WHERE id = ${id}`);
    const keys: string[] = [];
    const spy = withOverrides(boss, {
      send: async (queue, data, options) => {
        keys.push(options.singletonKey);
        return await boss.send(queue, data, options);
      },
    });
    await relayOutbox(app.db, spy);
    expect(keys).toEqual([id]);
  });

  it('a hung send is cut off by the timeout, stops the batch and burns no attempt', async () => {
    await addOutbox('order-created:hang');
    await addOutbox('order-created:hang-2');
    let calls = 0;
    const hang = withOverrides(boss, {
      send: () => {
        calls += 1;
        return new Promise(() => undefined);
      },
    });
    const result = await relayOutbox(app.db, hang, { sendTimeoutMs: 100 });
    expect(result).toMatchObject({ published: 0, failed: 1, stuck: 0 });
    expect(calls).toBe(1);
    const row = await app.db.execute<{ attempts: number }>(sql`SELECT attempts FROM outbox`);
    expect(row.rows.every((r) => r.attempts === 0)).toBe(true);
  });

  it('a failing mark UPDATE aborts the batch (it is not mistaken for a send failure)', async () => {
    await addOutbox('order-created:mark');
    const breakingMark: TransactionRunner = {
      transaction: async (fn) =>
        await app.db.transaction(async (tx) => {
          const failing = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === 'update') {
                // the first UPDATE of the relay is the "published" mark: make it fail
                return () => {
                  throw new Error('mark failed');
                };
              }
              return Reflect.get(target, property, receiver) as unknown;
            },
          });
          return await fn(failing);
        }),
    };
    await expect(relayOutbox(breakingMark, publisherFor(boss))).rejects.toThrow('mark failed');
    expect(await unpublished()).toBe(1);
    // the send went out once and is collapsed on the re-send
    expect(await relayOutbox(app.db, publisherFor(boss))).toMatchObject({ published: 1 });
    expect(await jobCount()).toBe(1);
  });

  it('a row whose job was collapsed (null from pg-boss) still counts as published', async () => {
    await addOutbox('order-created:dup');
    await boss.send(QUEUE, { pre: 'existing' }, { singletonKey: 'order-created:dup' });
    expect(await relayOutbox(app.db, publisherFor(boss))).toMatchObject({
      published: 1,
      failed: 0,
    });
    expect(await jobCount()).toBe(1);
  });
});

describe('the consumer side: retries, dead letters and a real worker', () => {
  it('a job that keeps failing ends in the dead-letter queue, never silently lost', async () => {
    await addOutbox('order-created:dead');
    await relayOutbox(app.db, publisherFor(boss));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const jobs = await boss.fetch(QUEUE, { batchSize: 1 });
      expect(jobs).toHaveLength(1);
      await boss.fail(QUEUE, jobs[0]?.id ?? '', { error: 'provider 503' });
    }
    expect(await boss.fetch(QUEUE, { batchSize: 1 })).toHaveLength(0);
    const dead = await boss.fetch(DEAD_LETTER_QUEUE, { batchSize: 5 });
    expect(dead).toHaveLength(1);
  });

  it('boss.work delivers through the sender: one letter, also after a first failure', async () => {
    const provider = new FakeProvider();
    let first = true;
    const flaky: MessageSender = {
      send: async (message) => {
        if (first) {
          first = false;
          throw new Error('provider 503');
        }
        await provider.send(message);
      },
    };
    await registerWorkers(boss, flaky, 0.5);
    await addOutbox('order-created:work');
    await relayOutbox(app.db, publisherFor(boss));

    for (let wait = 0; wait < 60 && provider.delivered.length === 0; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(provider.delivered).toHaveLength(1);
    expect(provider.delivered[0]?.idempotencyKey).toBe('order-created:work');
  });
});
