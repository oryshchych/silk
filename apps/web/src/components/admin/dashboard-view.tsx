import type { AlertCode, DashboardDto, KpiChangeDto, KpiDto } from '@store/shared/dto/reports';
import { formatBps, formatMoney, money, type MoneyLocale } from '@store/shared/money';

import type { Translate } from '../../lib/admin/message-lookup';

const header = 'px-3 py-2 text-left font-medium';
const cell = 'px-3 py-2 align-top text-right';

const figure = (kpi: KpiDto, value: number, locale: MoneyLocale): string =>
  kpi.kind === 'money'
    ? formatMoney(money(value), locale)
    : new Intl.NumberFormat(locale === 'uk' ? 'uk-UA' : 'en-US').format(value);

function Change({
  kpi,
  change,
  t,
  locale,
}: {
  kpi: KpiDto;
  change: KpiChangeDto;
  t: Translate;
  locale: MoneyLocale;
}) {
  const sign = change.absolute > 0 ? '+' : '';
  return (
    <>
      {sign}
      {figure(kpi, change.absolute, locale)}
      {' / '}
      {change.percentBps === null
        ? t('noPercent')
        : `${change.percentBps > 0 ? '+' : ''}${formatBps(change.percentBps, locale)}`}
    </>
  );
}

/** Where an alert is resolved; `null` when no screen exists for it yet (the count still shows). */
export function alertHref(
  code: AlertCode,
  can: { orders: boolean; reports: boolean },
): string | null {
  switch (code) {
    case 'low_stock':
      return can.reports ? '/admin/reports/stock' : null;
    case 'payment_unknown':
      return can.orders ? '/admin/orders?pay=pending' : null;
    case 'outbox_stuck':
      return null;
    case 'refund_open':
    case 'reservation_expiring':
    case 'fiscal_failed':
    case 'waybill_unknown':
      return can.orders ? '/admin/orders' : null;
  }
}

/**
 * The dashboard as markup: key figures with the change against the previous period and the same
 * period last year (absolute always, percentage only when the earlier value is not zero), and the
 * alerts with read-only links. Pure: the DTO and a translator in, HTML out.
 */
export function DashboardView({
  dashboard,
  t,
  locale,
  can,
}: {
  dashboard: DashboardDto;
  t: Translate;
  locale: MoneyLocale;
  can: { orders: boolean; reports: boolean };
}) {
  const active = dashboard.alerts.filter((alert) => alert.count > 0);
  return (
    <div className="space-y-6">
      <p className="text-text-muted">
        {t('period', { from: dashboard.period.from, to: dashboard.period.to })}
        {' · '}
        {t('asOf', { time: dashboard.asOf.replace('T', ' ').slice(0, 16) })}
      </p>
      <section aria-labelledby="kpi-title">
        <h2 id="kpi-title" className="text-xl font-semibold">
          {t('kpiTitle')}
        </h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t('kpiTitle')}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={header}>
                  {t('columns.kpi')}
                </th>
                <th scope="col" className={header}>
                  {t('columns.current')}
                </th>
                <th scope="col" className={header}>
                  {t('columns.previous')}
                </th>
                <th scope="col" className={header}>
                  {t('columns.changePrevious')}
                </th>
                <th scope="col" className={header}>
                  {t('columns.lastYear')}
                </th>
                <th scope="col" className={header}>
                  {t('columns.changeLastYear')}
                </th>
              </tr>
            </thead>
            <tbody>
              {dashboard.kpis.map((kpi) => (
                <tr key={kpi.key} className="border-b border-border">
                  <th scope="row" className={`${header} font-normal`}>
                    {t(`kpi.${kpi.key}`)}
                  </th>
                  <td className={cell}>{figure(kpi, kpi.current, locale)}</td>
                  <td className={cell}>{figure(kpi, kpi.vsPrevious.previous, locale)}</td>
                  <td className={cell}>
                    <Change kpi={kpi} change={kpi.vsPrevious} t={t} locale={locale} />
                  </td>
                  <td className={cell}>
                    {kpi.vsLastYear === null
                      ? t('noLastYear')
                      : figure(kpi, kpi.vsLastYear.previous, locale)}
                  </td>
                  <td className={cell}>
                    {kpi.vsLastYear === null ? (
                      ''
                    ) : (
                      <Change kpi={kpi} change={kpi.vsLastYear} t={t} locale={locale} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-text-muted">{t('changeNote')}</p>
        <p className="text-text-muted">
          {t('previousPeriod', { from: dashboard.previous.from, to: dashboard.previous.to })}
          {dashboard.lastYear === null
            ? ''
            : ` · ${t('lastYearPeriod', { from: dashboard.lastYear.from, to: dashboard.lastYear.to })}`}
        </p>
        {can.reports ? (
          <a href="/admin/reports/revenue" className="inline-flex min-h-11 items-center underline">
            {t('report')}
          </a>
        ) : null}
      </section>
      <section aria-labelledby="alerts-title">
        <h2 id="alerts-title" className="text-xl font-semibold">
          {t('alertsTitle')}
        </h2>
        {active.length === 0 ? (
          <p role="status" aria-live="polite">
            {t('allClear')}
          </p>
        ) : (
          <ul className="mt-2 space-y-2" role="status" aria-live="polite">
            {active.map((alert) => {
              const href = alertHref(alert.code, can);
              return (
                <li key={alert.code}>
                  <span className="font-medium">{String(alert.count)}</span>{' '}
                  {t(`alerts.${alert.code}`)}
                  {alert.oldestAt === null
                    ? ''
                    : ` (${t('oldest', { time: alert.oldestAt.replace('T', ' ').slice(0, 16) })})`}
                  {href === null ? null : (
                    <a href={href} className="ml-3 inline-flex min-h-11 items-center underline">
                      {t('open')}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
