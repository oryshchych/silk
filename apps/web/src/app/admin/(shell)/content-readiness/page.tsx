import { computeContentReadiness, reportView } from '@store/core/content-readiness';
import { can } from '@store/core/auth-permissions';
import { getMessages } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { ContentReadinessView } from '@/components/admin/content-readiness-view';
import { makeTranslator } from '@/lib/admin/message-lookup';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { createRateLimiter } from '@/lib/rate-limit';
import { createSharedComputation } from '@/lib/shared-computation';

const PAGE_SIZE = 100;
const searchSchema = z.object({
  show: z.enum(['todo', 'all', 'drafts']).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
  refresh: z.enum(['1']).optional().catch(undefined),
});

/**
 * The whole catalogue is judged ONCE per minute for everybody (a shared in-flight computation, kept
 * 60 s, a refresh allowed when the kept one is 5 s old): a person reloading the screen, or ten of
 * them at once, cost one set of queries and one connection, never one per request. The computation
 * runs in a read-only transaction with its own statement timeout, so a slow report cannot hold a
 * connection longer than that. Each page then filters and cuts the kept result in memory.
 */
const shared = createSharedComputation(
  async () => {
    const db = await getDb();
    return await db.transaction(
      async (tx) => await computeContentReadiness(tx, { statementTimeoutMs: 25_000 }),
      { accessMode: 'read only' },
    );
  },
  { ttlMs: 60_000, minRefreshMs: 5_000 },
);
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

/**
 * What is missing before launch. Every role that may open the admin may read it: the report carries
 * no price, cost or customer data (its DTO has no such field), only the state of the catalogue
 * content. `private, no-store` and `noindex` come from the admin proxy for every `/admin` path.
 */
export default async function ContentReadinessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission('admin.view');
  if (!can(session.role, 'admin.view') || !limiter.check(session.userId).allowed) notFound();
  const raw = await searchParams;
  const parsed = searchSchema.parse({
    show: typeof raw['show'] === 'string' ? raw['show'] : undefined,
    page: typeof raw['page'] === 'string' ? raw['page'] : undefined,
    refresh: typeof raw['refresh'] === 'string' ? raw['refresh'] : undefined,
  });
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = makeTranslator(await getMessages({ locale }), 'admin.contentReadiness');
  const { value } = await shared.get(parsed.refresh === '1');
  const report = reportView(value, {
    show: parsed.show ?? 'todo',
    page: parsed.page ?? 1,
    pageSize: PAGE_SIZE,
  });
  return <ContentReadinessView report={report} t={t} />;
}
