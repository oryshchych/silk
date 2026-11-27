/**
 * The report registry: one entry point for the screen and the CSV export, so both render the SAME
 * `ReportResultDto` from the same query, the same rounding, the same period and the same filters.
 *
 * The permission is checked HERE, before any query: `reports.view` for every report, and
 * `catalog.cost.view` for the margin report (refused outright) and for the cost columns of the stock
 * report (absent from the result, not hidden). A role without it never receives a shape that can
 * hold a cost.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { can, type AdminRole } from '../auth/permissions.ts';
import type { Reader } from '@store/db/types';
import {
  granularityValues,
  reportNames,
  type ReportName,
  type ReportResultDto,
} from '@store/shared/dto/reports';

import { readMargin, readMarginBreakdown } from './margin.ts';
import {
  readCustomersReport,
  readOrdersReport,
  readProvidersReport,
  readPromosReport,
  readReturnsReport,
  readStockReport,
  readTopProducts,
  readViewedNotBought,
} from './others.ts';
import { parsePeriod, ReportInputError, type Period } from './period.ts';
import { readRevenue } from './revenue.ts';

/** Only inside a transaction: a slow report cannot hold its connection past this. */
export async function setStatementTimeout(db: Reader, ms: number): Promise<void> {
  await db.execute(sql.raw(`SET LOCAL statement_timeout = ${String(Math.trunc(ms))}`));
}

export class ReportForbiddenError extends Error {
  constructor() {
    super('this role may not read this report');
    this.name = 'ReportForbiddenError';
  }
}

export const isReportName = (value: string): value is ReportName =>
  (reportNames as readonly string[]).includes(value);

/** Every parameter any report takes, strict: an unknown key is a 400, never ignored. */
export const reportParamsSchema = z.strictObject({
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  granularity: z.enum(granularityValues).optional(),
  sort: z.enum(['units', 'revenue']).default('units'),
  by: z.enum(['product', 'category']).default('product'),
  threshold: z.coerce.number().int().min(0).max(1000).default(3),
});
export type ReportParams = z.input<typeof reportParamsSchema>;

/** Reports that are not about a period. */
const NO_PERIOD: readonly ReportName[] = ['stock'];
const COST_REQUIRED: readonly ReportName[] = ['margin'];

export interface ParsedReport {
  name: ReportName;
  period: Period | null;
  sort: 'units' | 'revenue';
  by: 'product' | 'category';
  threshold: number;
}

/** Validate the raw parameters (throws `ReportInputError`). */
export function parseReportRequest(name: ReportName, raw: unknown): ParsedReport {
  const parsed = reportParamsSchema.safeParse(raw);
  if (!parsed.success) throw new ReportInputError('bad_day');
  const { sort, by, threshold } = parsed.data;
  if (NO_PERIOD.includes(name)) return { name, period: null, sort, by, threshold };
  const period = parsePeriod({
    from: parsed.data.from ?? '',
    to: parsed.data.to ?? '',
    ...(parsed.data.granularity === undefined ? {} : { granularity: parsed.data.granularity }),
  });
  return { name, period, sort, by, threshold };
}

export function mayRunReport(role: AdminRole, name: ReportName): boolean {
  if (!can(role, 'reports.view')) return false;
  return !COST_REQUIRED.includes(name) || can(role, 'catalog.cost.view');
}

export async function runReport(
  db: Reader,
  request: ParsedReport,
  role: AdminRole,
  options: { statementTimeoutMs?: number } = {},
): Promise<ReportResultDto> {
  if (!mayRunReport(role, request.name)) throw new ReportForbiddenError();
  if (options.statementTimeoutMs !== undefined) {
    await setStatementTimeout(db, options.statementTimeoutMs);
  }
  const includeCost = can(role, 'catalog.cost.view');
  const { period } = request;
  const need = (): Period => {
    if (period === null) throw new ReportInputError('bad_day');
    return period;
  };
  switch (request.name) {
    case 'revenue': {
      const report = await readRevenue(db, need());
      const notes = ['codExcluded', 'giftCardsExcluded'];
      if (report.totals.untimedCaptures > 0 || report.totals.untimedRefunds > 0)
        notes.push('untimed');
      return {
        name: 'revenue',
        asOf: report.asOf,
        period: report.period,
        table: {
          columns: [
            { key: 'bucket', kind: 'date' },
            { key: 'gross', kind: 'money' },
            { key: 'refunds', kind: 'money' },
            { key: 'net', kind: 'money' },
          ],
          rows: report.series.map((p) => [p.bucket, p.gross, p.refunds, p.net]),
          totals: ['', report.totals.gross, report.totals.refunds, report.totals.net],
          truncated: false,
        },
        facts: [
          { key: 'captures', kind: 'int', value: report.totals.captures },
          { key: 'refundOperations', kind: 'int', value: report.totals.refundOperations },
        ],
        chart: {
          labels: report.series.map((p) => p.bucket),
          series: [
            { key: 'gross', values: report.series.map((p) => p.gross) },
            { key: 'refunds', values: report.series.map((p) => p.refunds) },
          ],
        },
        notes,
      };
    }
    case 'margin': {
      const totals = await readMargin(db, need());
      const { rows, rest } = await readMarginBreakdown(db, need(), { by: request.by, limit: 100 });
      const toRow = (r: (typeof rows)[number]) => [
        r.key,
        r.name,
        r.units,
        r.goodsRevenue,
        r.costOfGoods,
        r.margin,
        r.marginBps,
      ];
      const t = totals.totals;
      const notes = ['codExcluded', 'marginEvents', 'goodsOnlyBreakdown'];
      if (t.noCostLines > 0) notes.push('noCostLines');
      if (t.noShippingCostOrders > 0) notes.push('noShippingCost');
      return {
        name: 'margin',
        asOf: totals.asOf,
        period: totals.period,
        table: {
          columns: [
            { key: 'key', kind: 'text' },
            { key: 'name', kind: 'text' },
            { key: 'units', kind: 'int' },
            { key: 'goodsRevenue', kind: 'money' },
            { key: 'costOfGoods', kind: 'money' },
            { key: 'margin', kind: 'money' },
            { key: 'marginBps', kind: 'bps' },
          ],
          rows: [...rows, ...(rest === null ? [] : [rest])].map(toRow),
          totals: ['', '', null, t.goodsRevenue, t.costOfGoods, null, null],
          truncated: false,
        },
        facts: [
          { key: 'shippingCost', kind: 'money', value: t.shippingCost },
          { key: 'marginTotal', kind: 'money', value: t.margin },
          { key: 'marginBpsTotal', kind: 'bps', value: t.marginBps },
          { key: 'noCostLines', kind: 'int', value: t.noCostLines },
          { key: 'noCostRevenue', kind: 'money', value: t.noCostRevenue },
          { key: 'noShippingCostOrders', kind: 'int', value: t.noShippingCostOrders },
          { key: 'otherRefunds', kind: 'money', value: t.otherRefunds },
        ],
        chart: null,
        notes,
      };
    }
    case 'orders':
      return await readOrdersReport(db, need());
    case 'top-products':
      return await readTopProducts(db, need(), request.sort);
    case 'stock':
      return await readStockReport(db, { threshold: request.threshold, includeCost });
    case 'returns':
      return await readReturnsReport(db, need());
    case 'promos':
      return await readPromosReport(db, need());
    case 'customers':
      return await readCustomersReport(db, need());
    case 'providers':
      return await readProvidersReport(db, need());
    case 'viewed-not-bought':
      return await readViewedNotBought(db, need());
  }
}
