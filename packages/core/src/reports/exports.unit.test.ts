import { describe, expect, it } from 'vitest';

import * as reports from './index.ts';

describe('the public API of the reports module', () => {
  it('exports no raw reader: every report runs through a read-only transaction', () => {
    const names = Object.keys(reports).sort();
    expect(names).toEqual(
      [
        'MAX_DAILY_DAYS',
        'MAX_PERIOD_DAYS',
        'REPORT_STATEMENT_TIMEOUT_MS',
        'ReportForbiddenError',
        'ReportInputError',
        'SHOP_TIMEZONE',
        'STEP',
        'TRUNC',
        'bpsPlainText',
        'changeOf',
        'daysInRange',
        'inReportTransaction',
        'isReportName',
        'isRealDay',
        'isoUtc',
        'lastYearPeriod',
        'lowerBound',
        'marginBreakdown',
        'marginReport',
        'mayRunReport',
        'parsePeriod',
        'parseReportRequest',
        'periodInputSchema',
        'previousPeriod',
        'reportParamsSchema',
        'resultToCsv',
        'revenueComparison',
        'revenueReport',
        'runDashboard',
        'runReport',
        'shiftDay',
        'shopDay',
        'shopToday',
        'upperBound',
      ].sort(),
    );
    expect(names.filter((name) => name.startsWith('read'))).toEqual([]);
  });
});
