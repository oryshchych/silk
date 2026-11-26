import { readContentReadiness, REPORT_PRODUCT_LIMIT } from '@store/core/content-readiness';
import { getMessages } from 'next-intl/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { ContentReadinessView, type ShowMode } from '@/components/admin/content-readiness-view';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { makeTranslator } from '@/lib/admin/message-lookup';
import { getDb } from '@/lib/db';

const searchSchema = z.object({
  show: z.enum(['todo', 'all', 'drafts']).optional().catch(undefined),
  target: z.coerce.number().int().min(0).max(100_000).optional().catch(undefined),
});

/**
 * What is missing before launch, read from the database on every request (never cached). Every role
 * that may open the admin may read it: the report carries no price, cost or customer data (its DTO
 * has no such field), only the state of the catalogue content. `private, no-store` and `noindex`
 * come from the admin proxy for every `/admin` path.
 */
export default async function ContentReadinessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('admin.view');
  const raw = await searchParams;
  const parsed = searchSchema.parse({
    show: typeof raw['show'] === 'string' ? raw['show'] : undefined,
    target: typeof raw['target'] === 'string' ? raw['target'] : undefined,
  });
  const mode: ShowMode = parsed.show ?? 'todo';
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = makeTranslator(await getMessages({ locale }), 'admin.contentReadiness');
  const report = await readContentReadiness(
    await getDb(),
    parsed.target === undefined ? {} : { expectedActive: parsed.target },
  );
  return (
    <ContentReadinessView report={report} mode={mode} productLimit={REPORT_PRODUCT_LIMIT} t={t} />
  );
}
