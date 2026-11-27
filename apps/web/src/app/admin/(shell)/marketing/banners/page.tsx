import { listBannersAdmin } from '@store/core/banners';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { formatWhen } from '@/lib/admin/format';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

/** The banners, in display order, with whether each is shown right now (decided by the database clock). */
export default async function BannersPage() {
  await requirePermission('banners.edit');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.banners' });
  const banners = await listBannersAdmin(await getDb());
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-2 max-w-2xl text-text-muted">{t('intro')}</p>
      <p className="mt-3">
        <a
          href="/admin/marketing/banners/new"
          className="inline-flex min-h-11 items-center underline"
        >
          {t('create')}
        </a>
      </p>
      {banners.length === 0 ? <p className="mt-4">{t('empty')}</p> : null}
      <ul className="mt-4 flex flex-col gap-3">
        {banners.map((banner) => (
          <li key={banner.id} className="rounded-md border border-border p-3">
            <a
              href={`/admin/marketing/banners/${banner.id}`}
              className="inline-flex min-h-11 items-center underline"
            >
              {(locale === 'en' ? banner.titleEn : banner.titleUk) ?? banner.id}
            </a>
            <p className="text-sm text-text-muted">
              {banner.shownNow
                ? t('shownNow')
                : banner.desktop === null || banner.mobile === null
                  ? t('draft')
                  : t('notShown')}
              {banner.startsAt === null ? '' : ` · ${formatWhen(banner.startsAt, locale)}`}
              {banner.endsAt === null ? '' : ` → ${formatWhen(banner.endsAt, locale)}`}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
