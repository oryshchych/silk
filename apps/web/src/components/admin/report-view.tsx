import {
  granularityValues,
  type ReportChartDto,
  type ReportName,
  type ReportResultDto,
} from '@store/shared/dto/reports';
import type { MoneyLocale } from '@store/shared/money';

import { formatCell, LABELLED_COLUMNS, valueLabel } from '../../lib/admin/report-format';
import type { Translate } from '../../lib/admin/message-lookup';

const SORTS = ['units', 'revenue'] as const;
const GROUPS = ['product', 'category'] as const;
const header = 'px-3 py-2 text-left font-medium';
const cell = 'px-3 py-2 align-top';
const input = 'min-h-11 rounded-md border border-border bg-surface px-2';

export interface ReportFormValues {
  from: string;
  to: string;
  granularity: string;
  sort: string;
  by: string;
  threshold: string;
}

function Form({ name, values, t }: { name: ReportName; values: ReportFormValues; t: Translate }) {
  const hasPeriod = name !== 'stock';
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      {hasPeriod ? (
        <>
          <label className="flex flex-col gap-1">
            <span>{t('from')}</span>
            <input type="date" name="from" defaultValue={values.from} required className={input} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('to')}</span>
            <input type="date" name="to" defaultValue={values.to} required className={input} />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1">
          <span>{t('threshold')}</span>
          <input
            type="number"
            name="threshold"
            min={0}
            max={1000}
            defaultValue={values.threshold}
            className={input}
          />
        </label>
      )}
      {name === 'revenue' ? (
        <label className="flex flex-col gap-1">
          <span>{t('granularity')}</span>
          <select name="granularity" defaultValue={values.granularity} className={input}>
            {granularityValues.map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {name === 'top-products' ? (
        <label className="flex flex-col gap-1">
          <span>{t('sort')}</span>
          <select name="sort" defaultValue={values.sort} className={input}>
            {SORTS.map((value) => (
              <option key={value} value={value}>
                {t(value === 'units' ? 'sortUnits' : 'sortRevenue')}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {name === 'margin' ? (
        <label className="flex flex-col gap-1">
          <span>{t('by')}</span>
          <select name="by" defaultValue={values.by} className={input}>
            {GROUPS.map((value) => (
              <option key={value} value={value}>
                {t(value === 'product' ? 'byProduct' : 'byCategory')}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button type="submit" className="min-h-11 min-w-11 rounded-md border border-border px-3">
        {t('apply')}
      </button>
    </form>
  );
}

/**
 * A dependency-free bar chart, server-rendered: gross receipts and refunds per bucket. The same
 * numbers are in the table under it (the chart is a picture of the table, so it has a text
 * alternative), and the payload holds only what the table holds: no cost series exists.
 */
function Chart({ chart, t }: { chart: ReportChartDto; t: Translate }) {
  const gross = chart.series.find((s) => s.key === 'gross')?.values ?? [];
  const refunds = chart.series.find((s) => s.key === 'refunds')?.values ?? [];
  const peak = Math.max(1, ...gross, ...refunds);
  const count = Math.max(1, chart.labels.length);
  const width = 640;
  const height = 160;
  const slot = width / count;
  const bar = Math.max(1, Math.min(24, slot / 2 - 1));
  const y = (value: number): number => Math.round((value / peak) * (height - 4));
  return (
    <figure className="max-w-3xl">
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        role="img"
        aria-label={t('chartLabel')}
        className="w-full"
      >
        {chart.labels.map((label, i) => (
          <g key={label}>
            <rect
              x={i * slot + 1}
              y={height - y(gross[i] ?? 0)}
              width={bar}
              height={y(gross[i] ?? 0)}
              fill="currentColor"
            />
            <rect
              x={i * slot + 1 + bar}
              y={height - y(refunds[i] ?? 0)}
              width={bar}
              height={y(refunds[i] ?? 0)}
              fill="currentColor"
              opacity={0.4}
            />
          </g>
        ))}
      </svg>
      <figcaption className="text-text-muted">
        {t('legendGross')} / {t('legendRefunds')}
      </figcaption>
    </figure>
  );
}

/**
 * A report as markup. Pure: the result and a translator in, HTML out. Every cell is a string React
 * escapes (product names are staff text); the only links are built from a product UUID or a
 * customer key that the database produced.
 */
export function ReportView({
  result,
  t,
  locale,
  form,
  exportHref,
  refreshHref,
  customerHref,
  name,
  busy = false,
}: {
  result: ReportResultDto | null;
  name: ReportName;
  t: Translate;
  locale: MoneyLocale;
  form: ReportFormValues;
  exportHref: string | null;
  refreshHref: string | null;
  customerHref: boolean;
  busy?: boolean;
}) {
  return (
    <div className="space-y-4">
      <Form name={name} values={form} t={t} />
      {result === null ? (
        <p role="alert">{busy ? t('busy') : t('invalid')}</p>
      ) : (
        <ResultBody
          result={result}
          t={t}
          locale={locale}
          exportHref={exportHref}
          refreshHref={refreshHref}
          customerHref={customerHref}
        />
      )}
    </div>
  );
}

function ResultBody({
  result,
  t,
  locale,
  exportHref,
  refreshHref,
  customerHref,
}: {
  result: ReportResultDto;
  t: Translate;
  locale: MoneyLocale;
  exportHref: string | null;
  refreshHref: string | null;
  customerHref: boolean;
}) {
  const { table } = result;
  const text = (colKey: string, kind: (typeof table.columns)[number]['kind'], value: unknown) => {
    const raw = formatCell(
      kind,
      typeof value === 'string' || typeof value === 'number' ? value : null,
      locale,
    );
    return kind === 'text' && LABELLED_COLUMNS.has(colKey) ? valueLabel(t, raw) : raw;
  };
  return (
    <div className="space-y-4">
      <p className="text-text-muted">
        {t('asOf', { time: result.asOf.replace('T', ' ').slice(0, 16) })}
      </p>
      <ul className="list-disc pl-5 text-text-muted">
        {result.notes.map((note) => (
          <li key={note}>{t(`notes.${note}`)}</li>
        ))}
      </ul>
      {result.facts.length > 0 ? (
        <dl className="grid max-w-2xl grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          {result.facts.map((fact) => (
            <div key={fact.key} className="contents">
              <dt>{t(`facts.${fact.key}`)}</dt>
              <dd className="text-right font-medium">
                {formatCell(fact.kind, fact.value, locale)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {result.chart === null ? null : <Chart chart={result.chart} t={t} />}
      <div className="flex flex-wrap gap-3">
        {exportHref === null ? null : (
          <a href={exportHref} className="inline-flex min-h-11 items-center underline">
            {t('export')}
          </a>
        )}
        {refreshHref === null ? null : (
          <a href={refreshHref} className="inline-flex min-h-11 items-center underline">
            {t('refresh')}
          </a>
        )}
      </div>
      {table.rows.length === 0 ? (
        <p>{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t(`names.${result.name}`)}</caption>
            <thead>
              <tr className="border-b border-border">
                {table.columns.map((column) => (
                  <th key={column.key} scope="col" className={header}>
                    {t(`columns.${column.key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr
                  key={`${String(rowIndex)}-${String(row[0])}-${String(row[1])}`}
                  className="border-b border-border"
                >
                  {table.columns.map((column, i) => {
                    const value = row[i] ?? null;
                    const shown =
                      column.key === 'key' && value === ''
                        ? t('allOther')
                        : text(column.key, column.kind, value);
                    const numeric = column.kind !== 'text' && column.kind !== 'date';
                    return (
                      <td key={column.key} className={`${cell} ${numeric ? 'text-right' : ''}`}>
                        {customerHref &&
                        column.key === 'customer' &&
                        typeof value === 'string' &&
                        /^[0-9a-f]{32}$/.test(value) ? (
                          <a href={`/admin/customers/${value}`} className="underline">
                            {shown}
                          </a>
                        ) : (
                          shown
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {table.totals === null ? null : (
              <tfoot>
                <tr className="font-semibold">
                  {table.columns.map((column, i) => {
                    const value = table.totals?.[i] ?? null;
                    const shown =
                      i === 0 && value === '' ? t('total') : text(column.key, column.kind, value);
                    return (
                      <td
                        key={column.key}
                        className={`${cell} ${column.kind === 'text' || column.kind === 'date' ? '' : 'text-right'}`}
                      >
                        {shown}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {table.truncated ? <p className="text-text-muted">{t('truncated')}</p> : null}
    </div>
  );
}
