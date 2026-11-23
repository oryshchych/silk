/**
 * Scheduled jobs (docs/architecture/08-worker.md): the reservation expiry, the counter
 * reconciliation and the Nova Poshta directory sync. Each job is a pg-boss queue with a cron
 * schedule; the handler is a plain function so a test can run it without waiting for the clock.
 *
 * Results are written as one JSON line each: counts and error classes only, never order or
 * customer data. A failing expiry carries the error name and code (a `StockDriftError` is a
 * money alert: it is logged at error level).
 */
import type { PgBoss } from 'pg-boss';

import { findReservedDrift, releaseExpiredOrders } from '@store/core/expiry';
import type { Reader, Tx } from '@store/db/types';

import type { NovaPoshtaDirectory } from './np/client.ts';
import { syncNpDirectory } from './np/sync.ts';

/** pg-boss queue names allow letters, digits, `_ - . /` but no colon, so `stock:release-expired` of the docs is `stock.release-expired` here. */
export const JOB_NAMES = {
  releaseExpired: 'stock.release-expired',
  reconcileStock: 'stock.reconcile',
  syncNp: 'np.sync-settlements',
} as const;

/** Cron expressions and their timezone (ADR-17): the timezone moves the schedule, nothing else. */
const SCHEDULES = {
  // Every ten minutes: a card reservation lives 30, an hourly run would hold stock up to 90.
  [JOB_NAMES.releaseExpired]: '*/10 * * * *',
  [JOB_NAMES.reconcileStock]: '35 * * * *',
  [JOB_NAMES.syncNp]: '0 3 * * *',
} as const;
const CRON_TZ = 'Europe/Kyiv';

export interface JobDeps {
  db: Reader & { transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };
  /** Null until the carrier key exists (Q2): the sync job then skips with a log line. */
  directory: NovaPoshtaDirectory | null;
  log?: (line: string) => void;
}

export type JobHandlers = Record<(typeof JOB_NAMES)[keyof typeof JOB_NAMES], () => Promise<void>>;

export function createJobHandlers(deps: JobDeps): JobHandlers {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const line = (fields: Record<string, unknown>): void => {
    log(JSON.stringify(fields));
  };
  return {
    [JOB_NAMES.releaseExpired]: async () => {
      const result = await releaseExpiredOrders(deps.db);
      line({
        level: result.failed > 0 ? 'error' : 'info',
        scope: JOB_NAMES.releaseExpired,
        expired: result.expired,
        skipped: result.skipped,
        failed: result.failed,
        failures: result.failures,
      });
      // A counter drift is a money alert that must not look like a finished job: fail it, so it
      // reaches the dead-letter queue instead of repeating quietly every run.
      if (result.failures.some((failure) => failure.code === 'STOCK_COUNTER_DRIFT')) {
        throw new Error('stock counter drift while releasing expired reservations');
      }
    },
    [JOB_NAMES.reconcileStock]: async () => {
      const drift = await findReservedDrift(deps.db);
      line({
        level: drift.length > 0 ? 'error' : 'info',
        scope: JOB_NAMES.reconcileStock,
        drifted: drift.length,
        // Variant ids only: they identify the product rows to inspect, nothing personal.
        variants: drift.slice(0, 20).map((entry) => entry.variantId),
      });
    },
    [JOB_NAMES.syncNp]: async () => {
      if (deps.directory === null) {
        line({ level: 'warn', scope: JOB_NAMES.syncNp, skipped: 'no carrier API key' });
        return;
      }
      const result = await syncNpDirectory(deps.db, deps.directory);
      line({ level: 'info', scope: JOB_NAMES.syncNp, ...result });
    },
  };
}

/** Creates the queues, schedules them, and starts one consumer each (concurrency 1). */
export async function registerJobs(boss: PgBoss, handlers: JobHandlers): Promise<void> {
  for (const [name, cron] of Object.entries(SCHEDULES)) {
    // The directory sync makes many sequential calls: give it an hour before pg-boss re-runs it.
    await boss.createQueue(name, {
      expireInSeconds: name === JOB_NAMES.syncNp ? 3600 : 900,
    });
    await boss.schedule(name, cron, undefined, { tz: CRON_TZ });
  }
  for (const [name, handler] of Object.entries(handlers)) {
    await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => {
      await handler();
    });
  }
}
