/**
 * The public face of the reports module: every function takes a `ReportDb` (something that can open
 * a transaction) and runs the report inside `inReportTransaction`: read only, one snapshot, its own
 * statement timeout. The raw readers (`readRevenue`, `readMargin`, ...) stay internal to the module.
 */
import type { MarginReportDto, RevenueReportDto } from '@store/shared/dto/reports';

import { readRevenueComparison, type RevenueComparison } from './comparison.ts';
import { readMargin, readMarginBreakdown, type MarginRowDto } from './margin.ts';
import type { Period } from './period.ts';
import { readRevenue } from './revenue.ts';
import { inReportTransaction, type ReportDb } from './transaction.ts';

export async function revenueReport(db: ReportDb, period: Period): Promise<RevenueReportDto> {
  return await inReportTransaction(db, async (tx) => await readRevenue(tx, period));
}

export async function revenueComparison(db: ReportDb, period: Period): Promise<RevenueComparison> {
  return await inReportTransaction(db, async (tx) => await readRevenueComparison(tx, period));
}

/** Cost data: the caller checks `catalog.cost.view` BEFORE calling. */
export async function marginReport(db: ReportDb, period: Period): Promise<MarginReportDto> {
  return await inReportTransaction(db, async (tx) => await readMargin(tx, period));
}

/** Cost data: the caller checks `catalog.cost.view` BEFORE calling. */
export async function marginBreakdown(
  db: ReportDb,
  period: Period,
  options: { by: 'product' | 'category'; limit?: number },
): Promise<{ rows: MarginRowDto[]; rest: MarginRowDto | null }> {
  return await inReportTransaction(
    db,
    async (tx) => await readMarginBreakdown(tx, period, options),
  );
}
