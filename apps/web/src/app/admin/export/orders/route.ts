import { writeAudit } from '@store/core/audit';
import { can } from '@store/core/auth-permissions';
import { exportOrdersCsv, ExportRangeError } from '@store/core/orders-admin-export';

import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { clientAddressOf } from '@/lib/request-limits';
import { createRateLimiter } from '@/lib/rate-limit';

/**
 * `GET /admin/export/orders?from=YYYY-MM-DD&to=YYYY-MM-DD[&after=<order number>]`: the accountant's
 * CSV. Checked here (a GET has no Origin; the cookie is `SameSite=Strict`): a full admin session read
 * from the database, the `orders.export` permission, a per-user limit. The file holds amounts and
 * statuses, no email, phone or cost. Every download is audited. `private, no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const refuse = (status: number, code: string, extra: Record<string, string> = {}): Response =>
  Response.json({ ok: false, code }, { status, headers: { ...HEADERS, ...extra } });

export async function GET(request: Request): Promise<Response> {
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return refuse(401, 'UNAUTHENTICATED');
  const { session } = resolved;
  if (!can(session.role, 'orders.export')) return refuse(403, 'FORBIDDEN');
  const verdict = limiter.check(session.userId);
  if (!verdict.allowed) {
    return refuse(429, 'RATE_LIMITED', { 'Retry-After': String(verdict.retryAfterSeconds) });
  }

  const params = new URL(request.url).searchParams;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const after = params.get('after') ?? undefined;
  if (after !== undefined && !/^[A-Z]{2}-\d{4}-\d{6}$/.test(after))
    return refuse(400, 'INVALID_INPUT');
  const db = await getDb();
  try {
    const file = await exportOrdersCsv(db, { from, to, after });
    const ip = await clientAddressOf(request);
    await db.transaction(async (tx) => {
      await writeAudit(tx, {
        userId: session.userId,
        action: 'export',
        entity: 'order',
        diff: { from, to, rows: file.rows, truncated: file.truncated, after: after ?? null },
        ip,
      });
    });
    return new Response(file.csv, {
      headers: {
        ...HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="orders-${from}-${to}.csv"`,
        ...(file.truncated && file.lastNumber !== null
          ? { 'X-Export-Truncated': 'true', 'X-Export-Next-After': file.lastNumber }
          : {}),
      },
    });
  } catch (error) {
    if (error instanceof ExportRangeError) return refuse(400, 'INVALID_INPUT');
    throw error;
  }
}
