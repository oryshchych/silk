import { getBannerAdmin } from '@store/core/banners';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { BannerForm } from '@/components/admin/banner-form';
import { BannerImageUpload } from '@/components/admin/banner-image-upload';
import { toKyivLocalInput } from '@/lib/admin/kyiv-time';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function EditBannerPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('banners.edit');
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.banners' });
  const banner = await getBannerAdmin(await getDb(), id.data);
  if (banner === null) notFound();
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('editTitle')}</h1>
      <section aria-labelledby="pictures" className="mt-4">
        <h2 id="pictures" className="text-lg font-semibold">
          {t('pictures')}
        </h2>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <BannerImageUpload bannerId={banner.id} slot="desktop" picture={banner.desktop} />
          <BannerImageUpload bannerId={banner.id} slot="mobile" picture={banner.mobile} />
        </div>
      </section>
      <div className="mt-6">
        <BannerForm
          existing={{
            banner,
            startsAtLocal: toKyivLocalInput(banner.startsAt),
            endsAtLocal: toKyivLocalInput(banner.endsAt),
          }}
        />
      </div>
    </div>
  );
}
