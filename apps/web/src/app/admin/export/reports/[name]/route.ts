import { writeAudit } from '@store/core/audit';
import { can } from '@store/core/auth-permissions';
import {
  isReportName,
  mayRunReport,
  parseReportRequest,
  ReportInputError,
  resultToCsv,
} from '@store/core/reports';

import { loadReport } from '@/lib/admin/reports-runner';
import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { BusyError } from '@/lib/keyed-computation';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientAddressOf } from '@/lib/request-limits';

/**
 * `GET /admin/export/reports/<name>?from&to[&granularity|sort|by|threshold]`: the CSV of a report,
 * the SAME result the screen shows (one function, one period, one rounding), through the same shared
 * computation. Checked before any query: a full admin session read from the database, the
 * `reports.export` permission, the report's own role rule (margin needs `catalog.cost.view`), a
 * per-user limit. The cost columns exist in the file only for a role that holds the cost
 * permission. Every download is audited (who, report, period, row count, whether cost was included).
 * `private, no-store`, `nosniff`, never indexed.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};
const refuse = (status: number, code: string, extra: Record<string, string> = {}): Response =>
  Response.json({ ok: false, code }, { status, headers: { ...HEADERS, ...extra } });

export async function GET(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return refuse(401, 'UNAUTHENTICATED');
  const { session } = resolved;
  const { name } = await context.params;
  if (
    !can(session.role, 'reports.export') ||
    !isReportName(name) ||
    !mayRunReport(session.role, name)
  ) {
    return refuse(403, 'FORBIDDEN');
  }
  const verdict = limiter.check(session.userId);
  if (!verdict.allowed) {
    return refuse(429, 'RATE_LIMITED', { 'Retry-After': String(verdict.retryAfterSeconds) });
  }
  const params = Object.fromEntries(new URL(request.url).searchParams);
  let parsed;
  try {
    parsed = parseReportRequest(name, params);
  } catch (error) {
    if (error instanceof ReportInputError) return refuse(400, 'INVALID_INPUT');
    throw error;
  }
  let result;
  try {
    result = await loadReport(parsed, session.role);
  } catch (error) {
    if (error instanceof BusyError) return refuse(503, 'BUSY', { 'Retry-After': '10' });
    throw error;
  }
  const includedCost = can(session.role, 'catalog.cost.view');
  const db = await getDb();
  const ip = await clientAddressOf(request);
  await db.transaction(async (tx) => {
    await writeAudit(tx, {
      userId: session.userId,
      action: 'export',
      entity: 'report',
      diff: {
        report: name,
        from: parsed.period?.from ?? null,
        to: parsed.period?.to ?? null,
        rows: result.table.rows.length,
        truncated: result.table.truncated,
        includedCost,
      },
      ip,
    });
  });
  const stamp = parsed.period === null ? 'now' : `${parsed.period.from}-${parsed.period.to}`;
  return new Response(resultToCsv(result), {
    headers: {
      ...HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="report-${name}-${stamp}.csv"`,
      'X-Report-As-Of': result.asOf,
    },
  });
}
