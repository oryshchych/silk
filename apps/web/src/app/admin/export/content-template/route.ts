import { contentTemplateCsv } from '@store/core/admin-template';
import { can } from '@store/core/auth-permissions';

import { currentSession } from '@/lib/admin/session';
import { createRateLimiter } from '@/lib/rate-limit';

/**
 * `GET /admin/export/content-template`: the header the import understands plus ONE example row that
 * the import refuses (its SKU starts with `EXAMPLE-`). No database read and no customer or cost
 * data: the same bytes for everyone who may import. Checked here: a full session, `catalog.import`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const refuse = (status: number, code: string): Response =>
  Response.json({ ok: false, code }, { status, headers: HEADERS });

export async function GET(): Promise<Response> {
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return refuse(401, 'UNAUTHENTICATED');
  if (!can(resolved.session.role, 'catalog.import')) return refuse(403, 'FORBIDDEN');
  if (!limiter.check(resolved.session.userId).allowed) return refuse(429, 'RATE_LIMITED');
  return new Response(contentTemplateCsv(), {
    headers: {
      ...HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="products-content-template.csv"',
    },
  });
}
