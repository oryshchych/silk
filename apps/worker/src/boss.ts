import { PgBoss, type Job } from 'pg-boss';

import { deliverJob, type MessageSender, type QueueJob } from './deliver.ts';

/** Topics the domain writes to `outbox` today; each gets a queue. */
export const OUTBOX_TOPICS = [
  'email.order-created',
  'email.payment-received',
  'alert.late-payment',
  'alert.double-payment',
  'alert.payment-mismatch',
] as const;

/** Jobs that exhausted their retries land here. Someone must watch this queue. */
export const DEAD_LETTER_QUEUE = 'outbox.dead';

export interface QueueTuning {
  retryLimit?: number;
  /** Seconds. Tests use 0. */
  retryDelay?: number;
  retryBackoff?: boolean;
}

/**
 * `exclusive`: one job queued OR active per singleton key, which is what makes a
 * re-sent outbox row collapse into the job that is already there. It is a
 * duplicate guard only: a failed or finished job does not block a later re-send.
 *
 * Consumers can fail (provider 5xx), so jobs retry with backoff and, when the
 * retries run out, move to a dead-letter queue instead of vanishing while the
 * outbox row already says "published".
 */
export async function startBoss(
  connectionString: string,
  tuning: QueueTuning = {},
): Promise<PgBoss> {
  // The pgboss schema is created by the DB init script and owned by store_boss, which has no
  // CREATE privilege on the database itself: pg-boss must not try to create it.
  const boss = new PgBoss({ connectionString, createSchema: false });
  await boss.start();
  await boss.createQueue(DEAD_LETTER_QUEUE, { policy: 'standard' });
  for (const topic of OUTBOX_TOPICS) {
    await boss.createQueue(topic, {
      policy: 'exclusive',
      retryLimit: tuning.retryLimit ?? 5,
      retryDelay: tuning.retryDelay ?? 30,
      retryBackoff: tuning.retryBackoff ?? true,
      deadLetter: DEAD_LETTER_QUEUE,
    });
  }
  return boss;
}

/** Starts a consumer per outbox topic. A thrown error makes pg-boss retry the job. */
export async function registerWorkers(
  boss: PgBoss,
  sender: MessageSender,
  pollingIntervalSeconds = 2,
): Promise<void> {
  for (const topic of OUTBOX_TOPICS) {
    await boss.work<QueueJob['data']>(
      topic,
      { pollingIntervalSeconds },
      async (jobs: Job<QueueJob['data']>[]) => {
        for (const job of jobs) await deliverJob(job, sender);
      },
    );
  }
}
