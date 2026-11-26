import { listReviewsForModeration } from '@store/core/reviews-moderation';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { ReviewModeration } from '@/components/admin/review-moderation';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

const STATUSES = ['pending', 'approved', 'rejected'] as const;
const filterSchema = z.enum(['pending', 'approved', 'rejected']).catch('pending');

/** The review queue. The reviewer's e-mail is shown to the roles that hold `reviews.moderate` only. */
export default async function AdminReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('reviews.moderate');
  const raw = (await searchParams)['status'];
  const filter = filterSchema.parse(typeof raw === 'string' ? raw : undefined);
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.reviews' });
  const reviews = await listReviewsForModeration(await getDb(), filter);
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <nav aria-label={t('filter')} className="mt-3 flex gap-4">
        {STATUSES.map((status) => (
          <a
            key={status}
            href={`/admin/reviews?status=${status}`}
            aria-current={status === filter ? 'page' : undefined}
            className="inline-flex min-h-11 items-center underline aria-[current=page]:font-semibold"
          >
            {t(`status.${status}`)}
          </a>
        ))}
      </nav>
      {reviews.length === 0 ? <p className="mt-4">{t('empty')}</p> : null}
      <ul className="mt-4 flex flex-col gap-4">
        {reviews.map((review) => (
          <li key={review.id} className="rounded-md border border-border p-3">
            <ReviewModeration review={review} />
          </li>
        ))}
      </ul>
    </div>
  );
}
