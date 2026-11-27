import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { SHOP_TIMEZONE } from './period.ts';
import { inReportTransaction, type ReportDb } from './transaction.ts';

/** Today in the shop zone, decided by the database (the default period of a report screen). */
export async function shopToday(db: ReportDb): Promise<string> {
  return await inReportTransaction(db, async (tx) => {
    const result = await tx.execute(
      sql`SELECT to_char((now() AT TIME ZONE ${sql.raw(`'${SHOP_TIMEZONE}'`)})::date, 'YYYY-MM-DD') AS today`,
    );
    return z.object({ today: z.string() }).parse(result.rows[0]).today;
  });
}
