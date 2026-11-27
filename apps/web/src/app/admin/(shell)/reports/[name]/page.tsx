import { can } from '@store/core/auth-permissions';
import {
  isReportName,
  mayRunReport,
  parseReportRequest,
  ReportInputError,
  shiftDay,
  type ParsedReport,
} from '@store/core/reports';
import type { ReportResultDto } from '@store/shared/dto/reports';
import { getMessages } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { ReportView, type ReportFormValues } from '@/components/admin/report-view';
import { makeTranslator } from '@/lib/admin/message-lookup';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { loadReport, shopToday } from '@/lib/admin/reports-runner';
import { requirePermission } from '@/lib/admin/session';
import { BusyError } from '@/lib/keyed-computation';
import { createRateLimiter } from '@/lib/rate-limit';

const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
const first = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * One report. The role is checked BEFORE anything is computed: a role without `reports.view`, or
 * without `catalog.cost.view` for the margin report, gets the same 404 as an address that does not
 * exist, so the URL of the margin report tells a manager nothing. The result is shared for 60 s and
 * computed in a read-only transaction (`lib/admin/reports-runner.ts`); the export link points at
 * the same parameters.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { name } = await params;
  const session = await requirePermission('reports.view');
  if (!isReportName(name) || !mayRunReport(session.role, name)) notFound();
  if (!limiter.check(session.userId).allowed) notFound();
  const raw = await searchParams;
  const today = await shopToday();
  const values: ReportFormValues = {
    from: first(raw['from']) ?? shiftDay(today, -29),
    to: first(raw['to']) ?? today,
    granularity: first(raw['granularity']) ?? 'day',
    sort: first(raw['sort']) ?? 'units',
    by: first(raw['by']) ?? 'product',
    threshold: first(raw['threshold']) ?? '3',
  };
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = makeTranslator(await getMessages({ locale }), 'admin.reports');
  let request: ParsedReport | null = null;
  let result: ReportResultDto | null = null;
  let busy = false;
  try {
    request = parseReportRequest(name, {
      from: values.from,
      to: values.to,
      granularity: values.granularity,
      sort: values.sort,
      by: values.by,
      threshold: values.threshold,
    });
    result = await loadReport(request, session.role, first(raw['refresh']) === '1');
  } catch (error) {
    if (error instanceof BusyError) busy = true;
    else if (!(error instanceof ReportInputError)) throw error;
  }
  const query = new URLSearchParams({
    from: values.from,
    to: values.to,
    granularity: values.granularity,
    sort: values.sort,
    by: values.by,
    threshold: values.threshold,
  }).toString();
  return (
    <>
      <h1 className="text-2xl font-semibold">{t(`names.${name}`)}</h1>
      <p className="mt-2 text-text-muted">{t(`descriptions.${name}`)}</p>
      <div className="mt-4">
        <ReportView
          name={name}
          result={result}
          t={t}
          locale={locale}
          form={values}
          busy={busy}
          exportHref={
            result !== null && can(session.role, 'reports.export')
              ? `/admin/export/reports/${name}?${query}`
              : null
          }
          refreshHref={result === null ? null : `/admin/reports/${name}?${query}&refresh=1`}
          customerHref={can(session.role, 'customers.view')}
        />
      </div>
      <p className="mt-4">
        <a href="/admin/reports" className="inline-flex min-h-11 items-center underline">
          {t('back')}
        </a>
      </p>
    </>
  );
}
