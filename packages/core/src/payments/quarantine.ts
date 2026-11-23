/** Retention of `webhook_quarantine` (`quarantine:cleanup`): old rows are for nobody. */
import { sql } from 'drizzle-orm';

import type { Tx } from '@store/db/types';

export const QUARANTINE_RETENTION_DAYS = 14;

/** Deletes quarantined messages older than the retention; returns how many were removed. */
export async function purgeQuarantine(
  tx: Tx,
  days: number = QUARANTINE_RETENTION_DAYS,
): Promise<number> {
  const removed = await tx.execute<{ id: string }>(
    sql`DELETE FROM webhook_quarantine
         WHERE created_at < now() - make_interval(days => ${days})
        RETURNING id`,
  );
  return removed.rows.length;
}
