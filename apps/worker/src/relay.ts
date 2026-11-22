/**
 * Outbox relay (ADR-4): moves committed `outbox` rows into pg-boss queues.
 *
 * The domain writes the outbox row in the same transaction as the state change
 * (so a crash can lose neither); this relay delivers it afterwards, at least
 * once:
 *
 *   BEGIN; SELECT ... FOR UPDATE SKIP LOCKED;  send to pg-boss;  mark published; COMMIT
 *
 * - Crash BEFORE the commit: the row is still unpublished and is picked up
 *   again after a restart.
 * - Crash AFTER the send but BEFORE the commit: the row is sent a second time
 *   with the SAME singleton key, which pg-boss collapses while the first job is
 *   still queued or active. If the first job already finished, the consumer
 *   dedupes through the provider's idempotency key (deliver.ts). Exactly-once is
 *   built from these two, not from the relay alone.
 * - Two relays at once: SKIP LOCKED gives each its own rows.
 *
 * Why the send is not inside the same database transaction (pg-boss's `db`
 * option): pg-boss lives in a schema owned by a separate role (`store_boss`)
 * that the app role cannot write to. Sharing one transaction would need that
 * grant, which is an infrastructure decision (OWNER_QUEUE Q14).
 *
 * Failure accounting is deterministic, not inferred from the rest of the batch:
 *
 * - Before any lock is taken a probe asks the queue backend whether it answers; if
 *   not, the whole tick is skipped (no locks, no attempts burned).
 * - A failure that looks like infrastructure (timeout, refused or reset connection)
 *   stops the batch at once and burns no attempt: the queue dropped mid-batch, the
 *   remaining rows would only wait out a timeout each while holding the locks.
 * - Any other failure (a payload pg-boss rejects, a topic without a queue, a send
 *   that collapses into no job at all) is the ROW's problem: it burns an attempt, the
 *   batch carries on, and at the limit the row is reported as `stuck`. Healthy rows
 *   behind poison rows are therefore always reached.
 */
import { and, asc, isNull, lt, sql } from 'drizzle-orm';

import { outbox } from '@store/db/schema';
import type { Tx } from '@store/db/types';

export interface QueuePublisher {
  /** Returns the job id, or null when pg-boss collapsed it into an existing job. */
  send(queue: string, data: object, options: { singletonKey: string }): Promise<string | null>;
  /** Cheap check that the queue backend answers. Called before any row lock is taken. */
  isUp(): Promise<boolean>;
  /** Whether a job with this singleton key exists, to tell a real collapse from a lost job. */
  hasJob(queue: string, singletonKey: string): Promise<boolean>;
}

export interface TransactionRunner {
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export interface RelayOptions {
  batchSize?: number;
  /** A poison row stops being retried after this many failures and is reported as `stuck`. */
  maxAttempts?: number;
  /** One hung call must not hold the batch locks and a pool connection for long. */
  sendTimeoutMs?: number;
}

export interface RelayResult {
  published: number;
  failed: number;
  /** Rows left unpublished that the relay no longer retries: a human must look at them. */
  stuck: number;
  /** The queue backend did not answer the probe: nothing was locked or sent. */
  skipped: boolean;
}

/** pg-boss queue names are the outbox topics. */
export const queueFor = (topic: string): string => topic;

export class SendTimeoutError extends Error {
  constructor() {
    super('send timed out');
    this.name = 'SendTimeoutError';
  }
}

/** pg-boss answered null but no job with that key exists: the message would be lost. */
export class LostJobError extends Error {
  constructor() {
    super('send returned no job and none exists for the key');
    this.name = 'LostJobError';
  }
}

const INFRASTRUCTURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01',
  '57P03',
  '08000',
  '08003',
  '08006',
]);

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Walks the cause chain: drivers and pg-boss wrap the network error. */
export function isInfrastructureError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; depth < 5; depth += 1) {
    if (current instanceof SendTimeoutError) return true;
    const code = codeOf(current);
    if (code !== undefined && INFRASTRUCTURE_CODES.has(code)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Only the error class and driver code are stored: messages from the driver or
 * pg-boss can carry hosts, user names or echoed parameters (emails), and this
 * column may be shown in an admin screen later.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const code = codeOf(error);
  return `${error.name}${code === undefined ? '' : `:${code}`}`.slice(0, 120);
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SendTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function countStuck(tx: Tx, maxAttempts: number): Promise<number> {
  const stuck = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(outbox)
    .where(and(isNull(outbox.publishedAt), sql`${outbox.attempts} >= ${maxAttempts}`));
  return stuck[0]?.n ?? 0;
}

export async function relayOutbox(
  db: TransactionRunner,
  publisher: QueuePublisher,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 20;
  const maxAttempts = options.maxAttempts ?? 10;
  const sendTimeoutMs = options.sendTimeoutMs ?? 10_000;

  const up = await withTimeout(publisher.isUp(), sendTimeoutMs).catch(() => false);
  if (!up) {
    const stuck = await db.transaction(async (tx) => await countStuck(tx, maxAttempts));
    return { published: 0, failed: 0, stuck, skipped: true };
  }

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: outbox.id,
        topic: outbox.topic,
        payload: outbox.payload,
        dedupKey: outbox.dedupKey,
      })
      .from(outbox)
      .where(and(isNull(outbox.publishedAt), lt(outbox.attempts, maxAttempts)))
      .orderBy(asc(outbox.createdAt), asc(outbox.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    const failures: { id: string; error: string; countsAsAttempt: boolean }[] = [];
    let published = 0;
    for (const row of rows) {
      // Never an empty key: on an exclusive queue an empty one would silently collapse rows.
      const key = row.dedupKey !== null && row.dedupKey !== '' ? row.dedupKey : row.id;
      const queue = queueFor(row.topic);
      let sent = false;
      try {
        const jobId = await withTimeout(
          publisher.send(
            queue,
            { outboxId: row.id, topic: row.topic, payload: row.payload, dedupKey: key },
            { singletonKey: key },
          ),
          sendTimeoutMs,
        );
        // null = collapsed into an existing job. Believe it only if that job exists.
        if (jobId === null && !(await withTimeout(publisher.hasJob(queue, key), sendTimeoutMs))) {
          throw new LostJobError();
        }
        sent = true;
      } catch (error) {
        const infrastructure = isInfrastructureError(error);
        failures.push({
          id: row.id,
          error: describeError(error),
          countsAsAttempt: !infrastructure,
        });
        if (infrastructure) break; // the queue dropped: do not wait out a timeout per row
      }
      // Outside the try: a failure of the mark must abort the transaction (the whole
      // batch is then re-sent, which is still at-least-once), not be taken for a send failure.
      if (sent) {
        await tx
          .update(outbox)
          .set({ publishedAt: sql`now()`, attempts: sql`${outbox.attempts} + 1`, lastError: null })
          .where(sql`${outbox.id} = ${row.id}`);
        published += 1;
      }
    }

    for (const failure of failures) {
      await tx
        .update(outbox)
        .set({
          attempts: failure.countsAsAttempt ? sql`${outbox.attempts} + 1` : outbox.attempts,
          lastError: failure.error,
        })
        .where(sql`${outbox.id} = ${failure.id}`);
    }

    return {
      published,
      failed: failures.length,
      stuck: await countStuck(tx, maxAttempts),
      skipped: false,
    };
  });
}
