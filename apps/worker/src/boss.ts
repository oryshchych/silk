import { PgBoss, type Job } from 'pg-boss';

import { deliverJob, type MessageSender, type QueueJob } from './deliver.ts';
import type { QueuePublisher } from './relay.ts';

/** Topics the domain writes to `outbox` today; each gets a queue. */
export const OUTBOX_TOPICS = [
  'email.order-created',
  'email.payment-received',
  'alert.late-payment',
  'alert.double-payment',
  'alert.payment-mismatch',
  'alert.refund-due',
  'email.refund-issued',
  'email.payment-failed',
  'fiscal.issue-receipt',
  'alert.fiscal-failed',
  'alert.attempt-unresolved',
  // Phase 5: the refund sweep, the waybill (buyer email, and the alert for a parcel made for a
  // cancelled order). A topic the domain writes without a queue ends `stuck` and nobody sees it.
  'alert.refund-unresolved',
  'email.waybill-created',
  'alert.waybill-for-cancelled-order',
  // Phase 7: the account links (written by `requestRegistration` and `requestPasswordReset`) and the
  // back-in-stock mail. Without a queue each of these ends `stuck`: nobody could register or reset.
  'email.account-verify',
  'email.password-reset',
  'email.back-in-stock',
  // Phase 11: the one reminder of an abandoned cart.
  'email.cart-reminder',
  // Phase 11: the newsletter double opt-in mail. Without a queue nobody could ever confirm.
  'email.newsletter-confirm',
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
 * Deliberate defaults. Mail and money alerts must survive HOURS of provider
 * outage: 20 retries with exponential backoff capped at one hour is roughly half a
 * day. The dead-letter queue keeps what is left for 30 days so a human can redrive it.
 */
const DEFAULT_RETRY = { retryLimit: 20, retryDelay: 60, retryBackoff: true, retryDelayMax: 3600 };
const DEAD_LETTER_RETENTION_SECONDS = 30 * 24 * 60 * 60;

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
  await boss.createQueue(DEAD_LETTER_QUEUE, {
    policy: 'standard',
    retentionSeconds: DEAD_LETTER_RETENTION_SECONDS,
  });
  const retryBackoff = tuning.retryBackoff ?? DEFAULT_RETRY.retryBackoff;
  for (const topic of OUTBOX_TOPICS) {
    await boss.createQueue(topic, {
      policy: 'exclusive',
      retryLimit: tuning.retryLimit ?? DEFAULT_RETRY.retryLimit,
      retryDelay: tuning.retryDelay ?? DEFAULT_RETRY.retryDelay,
      retryBackoff,
      // retryDelayMax is only valid together with backoff.
      ...(retryBackoff ? { retryDelayMax: DEFAULT_RETRY.retryDelayMax } : {}),
      deadLetter: DEAD_LETTER_QUEUE,
    });
  }
  return boss;
}

/** Starts a consumer per outbox topic, one job at a time. A thrown error makes pg-boss retry the job. */
export async function registerWorkers(
  boss: PgBoss,
  sender: MessageSender,
  pollingIntervalSeconds = 2,
): Promise<void> {
  for (const topic of OUTBOX_TOPICS) {
    await boss.work<QueueJob['data']>(
      topic,
      { pollingIntervalSeconds, batchSize: 1 },
      async (jobs: Job<QueueJob['data']>[]) => {
        for (const job of jobs) await deliverJob(job, sender);
      },
    );
  }
}

/** The publisher the relay uses, over a started pg-boss. */
export function bossPublisher(boss: PgBoss): QueuePublisher {
  return {
    send: async (queue, data, options) => await boss.send(queue, data, options),
    isUp: async () => (await boss.getQueue(DEAD_LETTER_QUEUE)) !== null,
    hasJob: async (queue, singletonKey) =>
      (await boss.findJobs(queue, { key: singletonKey, limit: 1 })).length > 0,
  };
}
