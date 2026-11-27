import { writeAudit } from '@store/core/audit';
import { can } from '@store/core/auth-permissions';
import { exportPromoCodesCsv } from '@store/core/promo-admin';

import { parsePromoFilters } from '@/lib/admin/promo-filters';
import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { clientAddressOf } from '@/lib/request-limits';
import { createRateLimiter } from '@/lib/rate-limit';

/**
 * `GET /admin/export/promo-codes?<the list filters>`: the promo-code list as CSV, the same rows the
 * screen shows. Own permission (`promo.manage`), per-user limit, one audit row per download.
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

export async function GET(request: Request): Promise<Response> {
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return refuse(401, 'UNAUTHENTICATED');
  const { session } = resolved;
  if (!can(session.role, 'promo.manage')) return refuse(403, 'FORBIDDEN');
  const verdict = limiter.check(session.userId);
  if (!verdict.allowed) {
    return refuse(429, 'RATE_LIMITED', { 'Retry-After': String(verdict.retryAfterSeconds) });
  }
  const filters = parsePromoFilters(Object.fromEntries(new URL(request.url).searchParams));
  const db = await getDb();
  const file = await exportPromoCodesCsv(db, filters);
  const ip = await clientAddressOf(request);
  await db.transaction(async (tx) => {
    await writeAudit(tx, {
      userId: session.userId,
      action: 'export',
      entity: 'promo_code',
      diff: { rows: file.rows, truncated: file.truncated },
      ip,
    });
  });
  return new Response(file.csv, {
    headers: {
      ...HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="promo-codes.csv"',
      ...(file.truncated ? { 'X-Export-Truncated': 'true' } : {}),
    },
  });
}
