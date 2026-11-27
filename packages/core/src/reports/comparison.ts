/**
 * Period comparison for the dashboard: the current period against the previous period of the same
 * length and against the same dates a year earlier (only when the shop has money data that old).
 * Each side is the same `readRevenue` the report uses, so the dashboard and the report can never
 * disagree. The absolute change is always given; the percentage is `null` when the previous value
 * is zero (divide-by-zero rule, `percentChangeBps`), and a fall to zero is exactly -100 %.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import type {
  ChangeDto,
  ComparisonDto,
  PeriodDto,
  RevenueReportDto,
} from '@store/shared/dto/reports';
import { percentChangeBps, subtract, type Money } from '@store/shared/money';

import { capturedRows, readRevenue, settledRefundRows } from './revenue.ts';
import { lastYearPeriod, previousPeriod, upperBound, type Period } from './period.ts';

export function changeOf(previous: Money, current: Money): ChangeDto {
  return {
    previous,
    current,
    absolute: subtract(current, previous),
    percentBps: percentChangeBps(previous, current),
  };
}

const earliestSchema = z.object({ has_data: z.boolean() });

/** True when the journal holds any money event BEFORE the end of the given day. */
async function hasDataBefore(db: Reader, day: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT (
      EXISTS (SELECT 1 FROM payment_attempts a
               WHERE ${capturedRows} AND a.completed_at < ${upperBound(day)})
      OR EXISTS (SELECT 1 FROM refund_operations r
                  LEFT JOIN payment_attempts a ON a.id = r.payment_attempt_id
                  WHERE ${settledRefundRows} AND r.settled_at < ${upperBound(day)})
    ) AS has_data
  `);
  return earliestSchema.parse(result.rows[0]).has_data;
}

const asDto = (report: RevenueReportDto): PeriodDto => report.period;

export interface RevenueComparison {
  current: RevenueReportDto;
  comparison: ComparisonDto;
}

export async function readRevenueComparison(
  db: Reader,
  period: Period,
): Promise<RevenueComparison> {
  const current = await readRevenue(db, period);
  const previous = await readRevenue(db, { ...previousPeriod(period), granularity: 'month' });
  const lastYearDays = lastYearPeriod(period);
  const lastYear = (await hasDataBefore(db, lastYearDays.to))
    ? await readRevenue(db, { ...lastYearDays, granularity: 'month' })
    : null;
  const pick = (key: 'gross' | 'refunds' | 'net'): ComparisonDto['gross'] => ({
    vsPrevious: changeOf(previous.totals[key], current.totals[key]),
    vsLastYear: lastYear === null ? null : changeOf(lastYear.totals[key], current.totals[key]),
  });
  return {
    current,
    comparison: {
      previous: asDto(previous),
      lastYear: lastYear === null ? null : asDto(lastYear),
      gross: pick('gross'),
      refunds: pick('refunds'),
      net: pick('net'),
    },
  };
}
