import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { alertCodes, type DashboardDto } from '@store/shared/dto/reports';

import en from '../../../messages/en.json';
import uk from '../../../messages/uk.json';
import { makeTranslator } from '../../lib/admin/message-lookup';
import { alertHref, DashboardView } from './dashboard-view';

const dashboard: DashboardDto = {
  asOf: '2026-11-27T10:00:00.000Z',
  period: { from: '2026-10-29', to: '2026-11-27', startsAt: 'x', endsAt: 'y' },
  previous: { from: '2026-09-29', to: '2026-10-28', startsAt: 'x', endsAt: 'y' },
  lastYear: null,
  kpis: [
    {
      key: 'gross',
      kind: 'money',
      current: 129_900,
      vsPrevious: { previous: 0, current: 129_900, absolute: 129_900, percentBps: null },
      vsLastYear: null,
    },
    {
      key: 'net',
      kind: 'money',
      current: 0,
      vsPrevious: { previous: 100_000, current: 0, absolute: -100_000, percentBps: -10_000 },
      vsLastYear: null,
    },
  ],
  alerts: [
    { code: 'low_stock', count: 4, oldestAt: null },
    { code: 'fiscal_failed', count: 0, oldestAt: null },
    { code: 'outbox_stuck', count: 2, oldestAt: '2026-11-27T09:00:00.000Z' },
  ],
};

const render = (locale: 'uk' | 'en') =>
  renderToStaticMarkup(
    createElement(DashboardView, {
      dashboard,
      t: makeTranslator(locale === 'uk' ? uk : en, 'admin.dashboardReports'),
      locale,
      can: { orders: true, reports: true },
    }),
  );

describe('DashboardView', () => {
  it('shows no percentage over a zero base and exactly minus 100 percent on a fall to zero', () => {
    const html = render('en');
    expect(html).toContain('n/a');
    expect(html).toContain('-100.0%');
    expect(html).toContain('No data that old');
  });
  it('formats money in the admin language and lists only alerts that have rows, with a link where a screen exists', () => {
    const html = render('uk');
    expect(html).toContain('1 299,00');
    expect(html).toContain('Потребує уваги');
    expect(html).toContain('/admin/reports/stock');
    expect(html).not.toContain('фіскальний чек не пробито');
    expect(html).toContain('Повідомлення, що чекають доставки');
    expect(html).not.toContain('admin.dashboardReports');
  });
  it('every alert has a label in both languages and a link rule', () => {
    for (const messages of [en, uk]) {
      const t = makeTranslator(messages, 'admin.dashboardReports');
      for (const code of alertCodes) expect(t(`alerts.${code}`)).not.toMatch(/^admin\./);
    }
    expect(alertHref('refund_open', { orders: false, reports: true })).toBeNull();
    expect(alertHref('outbox_stuck', { orders: true, reports: true })).toBeNull();
  });
});
