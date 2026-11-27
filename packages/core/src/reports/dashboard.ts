/**
 * The dashboard: revenue KPIs (gross, refunds, net, captures) for a period against the previous
 * period of the same length and against the same dates last year, the margin KPI only for a role that
 * may see cost (the KPI is not in the list for anyone else), and the alerts. Every figure is the SAME
 * function the report uses, so the dashboard and the report cannot disagree. Counts go through the
 * same change arithmetic as money (`percentChangeBps`): integers, no float, null on a zero base.
 */
import type { Reader } from '@store/db/types';
import type { DashboardDto, KpiChangeDto, KpiDto } from '@store/shared/dto/reports';
import { money, percentChangeBps, subtract } from '@store/shared/money';

import { readAlerts } from './alerts.ts';
import { readRevenueComparison } from './comparison.ts';
import { readMargin } from './margin.ts';
import { lastYearPeriod, previousPeriod, type Period } from './period.ts';
import { inReportTransaction, type ReportDb } from './transaction.ts';

const change = (previous: number, current: number): KpiChangeDto => ({
  previous,
  current,
  absolute: subtract(money(current), money(previous)),
  percentBps: percentChangeBps(money(previous), money(current)),
});

/** Internal: runs on a reader already inside a report transaction. Use `runDashboard`. */
export async function readDashboard(
  db: Reader,
  period: Period,
  options: { includeCost: boolean },
): Promise<DashboardDto> {
  const { current, comparison, previous, lastYear } = await readRevenueComparison(db, period);
  const kpis: KpiDto[] = [];
  const rev = (key: 'gross' | 'refunds' | 'net'): KpiDto => ({
    key,
    kind: 'money',
    current: current.totals[key],
    vsPrevious: comparison[key].vsPrevious,
    vsLastYear: comparison[key].vsLastYear,
  });
  kpis.push(rev('gross'), rev('refunds'), rev('net'));
  kpis.push({
    key: 'captures',
    kind: 'int',
    current: current.totals.captures,
    vsPrevious: change(previous.totals.captures, current.totals.captures),
    vsLastYear:
      lastYear === null ? null : change(lastYear.totals.captures, current.totals.captures),
  });
  if (options.includeCost) {
    const now = await readMargin(db, period);
    const prev = await readMargin(db, { ...previousPeriod(period), granularity: 'month' });
    const year =
      comparison.lastYear === null
        ? null
        : await readMargin(db, { ...lastYearPeriod(period), granularity: 'month' });
    kpis.push({
      key: 'margin',
      kind: 'money',
      current: now.totals.margin,
      vsPrevious: change(prev.totals.margin, now.totals.margin),
      vsLastYear: year === null ? null : change(year.totals.margin, now.totals.margin),
    });
  }
  return {
    asOf: current.asOf,
    period: current.period,
    previous: comparison.previous,
    lastYear: comparison.lastYear,
    kpis,
    alerts: await readAlerts(db),
  };
}

export async function runDashboard(
  db: ReportDb,
  period: Period,
  options: { includeCost: boolean },
): Promise<DashboardDto> {
  return await inReportTransaction(db, async (tx) => await readDashboard(tx, period, options));
}
