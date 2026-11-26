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

import { DomainError } from '@store/core/errors';

import { purgeEmailTokens, purgePendingAccounts } from '@store/core/customer-auth';
import { findReservedDrift, releaseExpiredOrders } from '@store/core/expiry';
import { findReceiptGaps } from '@store/core/fiscal-gaps';
import { purgeQuarantine } from '@store/core/quarantine';
import { reconcileOpenAttempts } from '@store/core/reconcile';
import { sweepRefunds } from '@store/core/refund-sweep';
import type { ProviderMap } from '@store/core/refunds';
import type { Reader, Tx } from '@store/db/types';

import { DEAD_LETTER_QUEUE } from './boss.ts';
import type { NovaPoshtaDirectory } from './np/client.ts';
import { syncNpDirectory } from './np/sync.ts';

/** pg-boss queue names allow letters, digits, `_ - . /` but no colon, so `stock:release-expired` of the docs is `stock.release-expired` here. */
export const JOB_NAMES = {
  releaseExpired: 'stock.release-expired',
  reconcileStock: 'stock.reconcile',
  syncNp: 'np.sync-settlements',
  /** ADR-4 source 2: ask the provider before anything is cancelled (Q17, Q27). */
  reconcileOpen: 'payments.reconcile-open',
  cleanQuarantine: 'quarantine.cleanup',
  reconcileFiscal: 'fiscal.reconcile',
  /** Q17: send refunds nobody sent, alert on those whose answer is unknown. */
  sweepRefunds: 'refunds.sweep',
  /** Phase 7: registrations nobody confirmed within a week are removed. */
  purgePendingAccounts: 'accounts.purge-pending',
} as const;

/** Cron expressions and their timezone (ADR-17): the timezone moves the schedule, nothing else. */
const SCHEDULES = {
  // Every ten minutes: a card reservation lives 30, an hourly run would hold stock up to 90.
  [JOB_NAMES.releaseExpired]: '*/10 * * * *',
  [JOB_NAMES.reconcileStock]: '35 * * * *',
  [JOB_NAMES.syncNp]: '0 3 * * *',
  // Every ten minutes, not hourly: it is what lets the expiry job (also every ten minutes) skip
  // an order only briefly, so stock is not held for an hour behind an unknown attempt.
  [JOB_NAMES.reconcileOpen]: '*/10 * * * *',
  [JOB_NAMES.cleanQuarantine]: '0 5 * * *',
  [JOB_NAMES.reconcileFiscal]: '0 6 * * *',
  [JOB_NAMES.sweepRefunds]: '*/10 * * * *',
  [JOB_NAMES.purgePendingAccounts]: '20 5 * * *',
} as const;
const CRON_TZ = 'Europe/Kyiv';

export interface JobDeps {
  db: Reader & { transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };
  /** Null until the carrier key exists (Q2): the sync job then skips with a log line. */
  directory: NovaPoshtaDirectory | null;
  /** The configured payment adapters; an absent one is simply not asked. */
  providers: ProviderMap;
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
      // A drifted counter is a money alert: fail the job so it reaches the dead-letter queue.
      if (drift.length > 0) throw new Error('stock counters drifted from the live reservations');
    },
    [JOB_NAMES.reconcileOpen]: async () => {
      const result = await reconcileOpenAttempts({ db: deps.db, providers: deps.providers });
      line({
        level:
          result.providerErrors > 0 || result.alerts > 0 || result.unaskable > 0 ? 'warn' : 'info',
        scope: JOB_NAMES.reconcileOpen,
        ...result,
      });
    },
    [JOB_NAMES.sweepRefunds]: async () => {
      const result = await sweepRefunds({
        providers: deps.providers,
        runInTransaction: async (fn) => await deps.db.transaction(fn),
      });
      line({
        level: result.failed > 0 || result.alerted > 0 ? 'warn' : 'info',
        scope: JOB_NAMES.sweepRefunds,
        ...result,
      });
    },
    [JOB_NAMES.cleanQuarantine]: async () => {
      const removed = await deps.db.transaction(async (tx) => await purgeQuarantine(tx));
      line({ level: 'info', scope: JOB_NAMES.cleanQuarantine, removed });
    },
    [JOB_NAMES.purgePendingAccounts]: async () => {
      const removed = await deps.db.transaction(async (tx) => await purgePendingAccounts(tx));
      const tokens = await deps.db.transaction(async (tx) => await purgeEmailTokens(tx));
      line({ level: 'info', scope: JOB_NAMES.purgePendingAccounts, removed, tokens });
    },
    [JOB_NAMES.reconcileFiscal]: async () => {
      const gaps = await findReceiptGaps(deps.db);
      line({
        level: gaps.missing > 0 ? 'error' : 'info',
        scope: JOB_NAMES.reconcileFiscal,
        missing: gaps.missing,
        // Order ids only: they identify the rows to inspect, nothing personal.
        orders: gaps.orderIds,
      });
      // Orders without a receipt are a money-side alert: fail the job so it reaches the dead-letter queue.
      if (gaps.missing > 0) throw new Error('paid or shipped orders have no fiscal receipt');
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

/** Only the name and the domain code of a failure reach pg-boss's job output (no stack, no paths). */
function scrub(error: unknown): Error {
  const name = error instanceof Error ? error.name : 'Error';
  const code = error instanceof DomainError ? ` ${error.code}` : '';
  const safe = new Error(`${name}${code}: job failed`);
  safe.stack = safe.message;
  return safe;
}

/**
 * Creates the queues, schedules them, and starts one consumer each (concurrency 1).
 *
 * `expiry` is ON by default since phase 3 (owner queue Q27): `payments.reconcile-open` now asks the
 * provider for every open attempt, and the expiry job skips orders with an attempt whose result is
 * unknown, so it cannot cancel an order that was paid while its webhook never arrived. Pass
 * `{ expiry: false }` only to run without it.
 */
export async function registerJobs(
  boss: PgBoss,
  handlers: JobHandlers,
  options: { expiry?: boolean } = {},
): Promise<void> {
  const enabled = Object.entries(SCHEDULES).filter(
    ([name]) => name !== JOB_NAMES.releaseExpired || options.expiry !== false,
  );
  for (const [name, cron] of enabled) {
    // The directory sync makes many sequential calls: give it an hour before pg-boss re-runs it.
    await boss.createQueue(name, {
      expireInSeconds: name === JOB_NAMES.syncNp ? 3600 : 900,
      // A job that fails by design (a drifted counter, a receipt gap) lands where the watcher of
      // the outbox looks (Q15), not only in `pgboss.job`.
      deadLetter: DEAD_LETTER_QUEUE,
    });
    await boss.schedule(name, cron, undefined, { tz: CRON_TZ });
  }
  const names = new Set(enabled.map(([name]) => name));
  for (const [name, handler] of Object.entries(handlers)) {
    if (!names.has(name)) continue;
    await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 5 }, async () => {
      try {
        await handler();
      } catch (error) {
        throw scrub(error);
      }
    });
  }
}
