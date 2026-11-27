import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { reportNames, type ReportResultDto } from '@store/shared/dto/reports';

import en from '../../../messages/en.json';
import uk from '../../../messages/uk.json';
import { makeTranslator } from '../../lib/admin/message-lookup';
import { ReportView } from './report-view';

const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
const FORM = {
  from: '2026-06-01',
  to: '2026-06-30',
  granularity: 'day',
  sort: 'units',
  by: 'product',
  threshold: '3',
};

const result: ReportResultDto = {
  name: 'top-products',
  asOf: '2026-11-27T10:00:00.000Z',
  period: null,
  facts: [{ key: 'paidOrders', kind: 'int', value: 12 }],
  chart: null,
  notes: ['ordersByCreation'],
  table: {
    columns: [
      { key: 'product', kind: 'text' },
      { key: 'name', kind: 'text' },
      { key: 'units', kind: 'int' },
      { key: 'revenue', kind: 'money' },
    ],
    rows: [
      ['p1', HOSTILE, 1234, 129_900],
      ['p2', 'Odd', 3, 12_345],
    ],
    totals: ['', '', 1234, -50_000],
    truncated: false,
  },
};

const render = (locale: 'uk' | 'en', value: ReportResultDto | null) =>
  renderToStaticMarkup(
    createElement(ReportView, {
      name: 'top-products',
      result: value,
      t: makeTranslator(locale === 'uk' ? uk : en, 'admin.reports'),
      locale,
      form: FORM,
      exportHref: '/admin/export/reports/top-products?from=2026-06-01',
      refreshHref: null,
      customerHref: false,
    }),
  );

describe('ReportView', () => {
  it('escapes staff text and formats money in the locale of the admin', () => {
    const html = render('uk', result);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('1 299,00');
    expect(html).toContain('Разом');
    expect(html).toContain('-500,00');
    expect(render('en', result)).toContain('1,299.00');
    expect(render('en', result)).toContain('123.45');
  });

  it('shows the data time, the notes and the export link; a failed run shows the alert and keeps the form', () => {
    const html = render('en', result);
    expect(html).toContain('Data as of 2026-11-27 10:00');
    expect(html).toContain('Orders are dated by the day they were created.');
    expect(html).toContain('href="/admin/export/reports/top-products?from=2026-06-01"');
    const failed = render('en', null);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('name="from"');
  });

  it('every label the screen can ask for exists in both languages', () => {
    for (const messages of [en, uk]) {
      const t = makeTranslator(messages, 'admin.reports');
      for (const name of reportNames) {
        expect(t(`names.${name}`)).not.toMatch(/^admin\.reports/);
        expect(t(`descriptions.${name}`)).not.toMatch(/^admin\.reports/);
      }
      for (const key of ['top', 'new', 'returning', 'defect', 'np_warehouse', 'cod', 'cancelled']) {
        expect(t(`values.${key}`)).not.toMatch(/^admin\.reports/);
      }
    }
  });

  it('a manager result has no cost column to render: the markup holds no cost label', () => {
    const html = render('en', result);
    expect(html.toLowerCase()).not.toMatch(/cost|margin/);
  });
});
