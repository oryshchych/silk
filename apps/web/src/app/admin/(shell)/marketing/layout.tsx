import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { can } from '@store/core/auth-permissions';

/** The marketing tabs. A tab is shown only to a role that may open it; each page checks again. */
export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const session = await requireFullSession();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.marketing' });
  return (
    <div>
      <nav aria-label={t('tabs')} className="mb-4 flex gap-4">
        {can(session.role, 'promo.view') ? (
          <a
            href="/admin/marketing/promo-codes"
            className="inline-flex min-h-11 items-center underline"
          >
            {t('promoCodes')}
          </a>
        ) : null}
        {can(session.role, 'banners.edit') ? (
          <a
            href="/admin/marketing/banners"
            className="inline-flex min-h-11 items-center underline"
          >
            {t('banners')}
          </a>
        ) : null}
      </nav>
      {children}
    </div>
  );
}
