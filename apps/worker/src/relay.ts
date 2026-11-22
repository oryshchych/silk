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
 * A failed send only counts against a row's attempt limit when OTHER rows of the
 * same batch went through: then the row itself is the problem (a poison
 * message). When nothing in the batch could be sent the queue is down, no
 * attempt is burned, and the batch stops after a short streak of failures
 * instead of waiting out one timeout per row.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '@store/db/types';

export interface QueuePublisher {
  /** Returns the job id, or null when pg-boss collapsed it into an existing job. */
  send(queue: string, data: object, options: { singletonKey: string }): Promise<string | null>;
}

export interface TransactionRunner {
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export interface RelayOptions {
  batchSize?: number;
  /** A poison row stops being retried after this many failures and is reported as `stuck`. */
  maxAttempts?: number;
  /** One hung send must not hold the batch locks and a pool connection for long. */
  sendTimeoutMs?: number;
}

export interface RelayResult {
  published: number;
  failed: number;
  /** Rows left unpublished that the relay no longer retries: a human must look at them. */
  stuck: number;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  topic: string;
  payload: unknown;
  dedup_key: string | null;
}

/** This many failures in a row, with nothing sent yet, is taken for an outage. */
const OUTAGE_STREAK = 3;

/** pg-boss queue names are the outbox topics. */
export const queueFor = (topic: string): string => topic;

/**
 * Only the error class and driver code are stored: messages from the driver or
 * pg-boss can carry hosts, user names or echoed parameters (emails), and this
 * column may be shown in an admin screen later.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const code = 'code' in error && typeof error.code === 'string' ? `:${error.code}` : '';
  return `${error.name}${code}`.slice(0, 120);
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('SendTimeout'));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function relayOutbox(
  db: TransactionRunner,
  publisher: QueuePublisher,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 20;
  const maxAttempts = options.maxAttempts ?? 10;
  const sendTimeoutMs = options.sendTimeoutMs ?? 10_000;

  return await db.transaction(async (tx) => {
    const rows = await tx.execute<OutboxRow>(
      sql`SELECT id, topic, payload, dedup_key FROM outbox
           WHERE published_at IS NULL AND attempts < ${maxAttempts}
           ORDER BY created_at, id
           LIMIT ${batchSize}
           FOR UPDATE SKIP LOCKED`,
    );

    const failures: { id: string; error: string }[] = [];
    let published = 0;
    let failureStreak = 0;
    for (const row of rows.rows) {
      const key = row.dedup_key ?? row.id;
      let sent = false;
      try {
        await withTimeout(
          publisher.send(
            queueFor(row.topic),
            { outboxId: row.id, topic: row.topic, payload: row.payload, dedupKey: key },
            { singletonKey: key },
          ),
          sendTimeoutMs,
        );
        sent = true;
      } catch (error) {
        failures.push({ id: row.id, error: describeError(error) });
        // Several failures in a row and nothing sent: the queue is probably down. Stop waiting
        // out one timeout per row. A single bad row at the head must not block the rest, so
        // the batch carries on until the streak reaches the threshold.
        failureStreak = published === 0 ? failureStreak + 1 : 0;
        if (failureStreak >= OUTAGE_STREAK) break;
      }
      // Outside the try: a failure of the mark must abort the transaction (the whole
      // batch is then re-sent, which is still at-least-once), not be taken for a send failure.
      if (sent) {
        await tx.execute(
          sql`UPDATE outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL
               WHERE id = ${row.id}`,
        );
        published += 1;
      }
    }

    const queueIsUp = published > 0;
    for (const failure of failures) {
      await tx.execute(
        sql`UPDATE outbox
               SET attempts = attempts + ${queueIsUp ? 1 : 0}, last_error = ${failure.error}
             WHERE id = ${failure.id}`,
      );
    }

    const stuck = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL AND attempts >= ${maxAttempts}`,
    );
    return { published, failed: failures.length, stuck: stuck.rows[0]?.n ?? 0 };
  });
}
