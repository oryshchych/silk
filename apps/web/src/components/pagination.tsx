import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { pageWindow } from '@/lib/page-window';

const REL = { prev: 'prev', next: 'next' } as const;

export async function Pagination({
  current,
  total,
  hrefFor,
}: {
  current: number;
  total: number;
  /** Link to a page, with the current filters kept. */
  hrefFor: (page: number) => string;
}) {
  if (total <= 1) return null;
  const t = await getTranslations('pagination');
  const linkClass =
    'inline-flex min-h-8 min-w-8 items-center justify-center rounded-sm border border-border px-2 text-sm hover:bg-surface-raised';
  return (
    <nav aria-label={t('label')} className="flex flex-wrap items-center justify-center gap-2">
      {current > 1 ? (
        <Link href={hrefFor(current - 1)} rel={REL.prev} className={linkClass}>
          {t('previous')}
        </Link>
      ) : null}
      {pageWindow(current, total).map((page, index) =>
        page === 'gap' ? (
          <span key={`gap-${String(index)}`} aria-hidden="true">
            …
          </span>
        ) : page === current ? (
          <span
            key={page}
            aria-current="page"
            aria-label={t('current', { page })}
            className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-sm bg-accent px-2 text-sm text-accent-contrast"
          >
            {page}
          </span>
        ) : (
          <Link
            key={page}
            href={hrefFor(page)}
            aria-label={t('page', { page })}
            className={linkClass}
          >
            {page}
          </Link>
        ),
      )}
      {current < total ? (
        <Link href={hrefFor(current + 1)} rel={REL.next} className={linkClass}>
          {t('next')}
        </Link>
      ) : null}
    </nav>
  );
}
