import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import type { SiteLocale } from '@store/shared/seo';

import { href } from '@/lib/paths';

export interface Crumb {
  name: string;
  /** Locale-less path; omit for the current page. */
  path?: string;
}

export async function Breadcrumbs({ locale, crumbs }: { locale: SiteLocale; crumbs: Crumb[] }) {
  const t = await getTranslations('breadcrumbs');
  return (
    <nav aria-label={t('label')} className="text-sm text-text-muted">
      <ol className="flex flex-wrap items-center gap-x-2">
        {crumbs.map((crumb, index) => (
          <li key={`${String(index)}-${crumb.name}`} className="flex items-center gap-x-2">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.path === undefined ? (
              <span aria-current="page" className="text-text-primary">
                {crumb.name}
              </span>
            ) : (
              <Link href={href(locale, crumb.path)} className="hover:underline">
                {crumb.name}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
