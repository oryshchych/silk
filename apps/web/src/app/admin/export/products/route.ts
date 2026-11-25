import { writeAudit } from '@store/core/audit';
import { can } from '@store/core/auth-permissions';
import { exportProductsCsv } from '@store/core/admin-export';
import { skuField } from '@store/core/admin-schemas';

import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { clientAddressOf } from '@/lib/request-limits';
import { createRateLimiter } from '@/lib/rate-limit';

/**
 * `GET /admin/export/products`: the product list as a CSV download. Checked here, in the route (a
 * GET has no Origin to check; the session cookie is `SameSite=Strict`, so another site cannot make
 * a browser send it): a full admin session read from the database, the `catalog.export`
 * permission, a per-user limit. The cost column is in the file only for a role with
 * `catalog.cost.view`. Every export is audited (who, how many rows, whether the cost was included).
 * `private, no-store`, never indexed.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const refuse = (status: number, code: string): Response =>
  Response.json({ ok: false, code }, { status, headers: HEADERS });

export async function GET(request: Request): Promise<Response> {
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return refuse(401, 'UNAUTHENTICATED');
  const { session } = resolved;
  if (!can(session.role, 'catalog.export')) return refuse(403, 'FORBIDDEN');
  if (!limiter.check(session.userId).allowed) return refuse(429, 'RATE_LIMITED');

  const db = await getDb();
  const canSeeCost = can(session.role, 'catalog.cost.view');
  // `after=<sku>` continues a file that was cut at the row limit (the screen lists the parts).
  const afterParam = new URL(request.url).searchParams.get('after');
  const after = afterParam === null ? undefined : skuField.safeParse(afterParam).data;
  if (afterParam !== null && after === undefined) return refuse(400, 'INVALID_INPUT');
  const { csv, rows, truncated, lastSku } = await exportProductsCsv(db, { canSeeCost, after });
  const ip = await clientAddressOf(request);
  await db.transaction(async (tx) => {
    await writeAudit(tx, {
      userId: session.userId,
      action: 'export',
      entity: 'product',
      diff: { rows, truncated, includedCost: canSeeCost, after: after ?? null },
      ip,
    });
  });
  return new Response(csv, {
    headers: {
      ...HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="products.csv"',
      // A file that stops at the row limit says so; the next part starts after `X-Export-Next-After`.
      ...(truncated && lastSku !== null
        ? { 'X-Export-Truncated': 'true', 'X-Export-Next-After': lastSku }
        : {}),
    },
  });
}
