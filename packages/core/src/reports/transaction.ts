/**
 * The ONE way a report runs (phase 9 lesson: a report page must not starve the connection pool).
 * `inReportTransaction` opens a READ ONLY transaction (a write inside is refused by Postgres itself,
 * SQLSTATE 25006), at repeatable read so a report made of several statements reads ONE snapshot,
 * with its own `statement_timeout` (a slow report is cancelled, SQLSTATE 57014, and cannot hold the
 * connection past it) and a recognisable `application_name`. The settings are transaction-local
 * (`set_config(..., true)`), so a pooled connection goes back unchanged.
 *
 * The public API of the reports module (`index.ts`) exposes only functions that take a `ReportDb` and
 * run through here; the raw readers stay internal, and a test pins the export list.
 */
import { sql } from 'drizzle-orm';

import type { Reader, Tx } from '@store/db/types';

export interface ReportDb {
  transaction: <T>(
    fn: (tx: Tx) => Promise<T>,
    config?: { accessMode?: 'read only' | 'read write'; isolationLevel?: 'repeatable read' },
  ) => Promise<T>;
}

export const REPORT_STATEMENT_TIMEOUT_MS = 25_000;

export async function inReportTransaction<T>(
  db: ReportDb,
  run: (tx: Reader) => Promise<T>,
  options: { statementTimeoutMs?: number } = {},
): Promise<T> {
  const timeout = Math.trunc(options.statementTimeoutMs ?? REPORT_STATEMENT_TIMEOUT_MS);
  return await db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeout)}, true)`);
      await tx.execute(sql`SELECT set_config('application_name', 'silk-report', true)`);
      return await run(tx);
    },
    { accessMode: 'read only', isolationLevel: 'repeatable read' },
  );
}
