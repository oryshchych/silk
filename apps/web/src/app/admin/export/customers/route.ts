import { writeAudit } from '@store/core/audit';
import { can } from '@store/core/auth-permissions';
import { exportCustomersCsv } from '@store/core/customers-admin-export';

import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { clientAddressOf } from '@/lib/request-limits';
import { createRateLimiter } from '@/lib/rate-limit';

/**
 * `GET /admin/export/customers[?after=<email>]`: the customer CSV, which carries personal data
 * (email, phone). Own permission (`customers.export`: owner and admin), a per-user limit, one audit
 * row per download with the row count. Checked in the route; `private, no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 });
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const refuse = (status: number, code: string, extra: Record<string, string> = {}): Response =>
  Response.json({ ok: false, code }, { status, headers: { ...HEADERS, ...extra } });

export async function GET(request: Request): Promise<Response> {
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return refuse(401, 'UNAUTHENTICATED');
  const { session } = resolved;
  if (!can(session.role, 'customers.export')) return refuse(403, 'FORBIDDEN');
  const verdict = limiter.check(session.userId);
  if (!verdict.allowed) {
    return refuse(429, 'RATE_LIMITED', { 'Retry-After': String(verdict.retryAfterSeconds) });
  }

  const afterParam = new URL(request.url).searchParams.get('after');
  if (afterParam !== null && (afterParam.length > 320 || afterParam.includes('\u0000'))) {
    return refuse(400, 'INVALID_INPUT');
  }
  const db = await getDb();
  const file = await exportCustomersCsv(db, { after: afterParam ?? undefined });
  const ip = await clientAddressOf(request);
  await db.transaction(async (tx) => {
    await writeAudit(tx, {
      userId: session.userId,
      action: 'export',
      entity: 'customer',
      diff: { rows: file.rows, truncated: file.truncated, continued: afterParam !== null },
      ip,
    });
  });
  return new Response(file.csv, {
    headers: {
      ...HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="customers.csv"',
      ...(file.truncated && file.lastEmail !== null
        ? { 'X-Export-Truncated': 'true', 'X-Export-Next-After': file.lastEmail }
        : {}),
    },
  });
}
