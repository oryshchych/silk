import { getAdminCategoryContent } from '@store/core/admin-read';
import { CONTENT_BOUNDS } from '@store/shared/content-bounds';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { CategoryContentForm } from '@/components/admin/category-content-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

/**
 * The texts of one category. Opening it needs `categories.edit` (checked here and again by the
 * action that saves it); the read is an explicit DTO of the category's own columns.
 */
export default async function CategoryContentPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('categories.edit');
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  const category = await getAdminCategoryContent(await getDb(), parsed.data);
  if (category === null) notFound();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.categoryEditor' });
  return (
    <div className="space-y-6">
      <p>
        <a href="/admin/categories" className="inline-flex min-h-11 items-center underline">
          {t('back')}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t('title', { name: category.nameUk })}</h1>
      <CategoryContentForm
        values={{
          categoryId: category.id,
          descriptionUk: category.descriptionUk,
          descriptionEn: category.descriptionEn,
          seoTextUk: category.seoTextUk,
          seoTextEn: category.seoTextEn,
          metaTitleUk: category.metaTitleUk,
          metaTitleEn: category.metaTitleEn,
          metaDescriptionUk: category.metaDescriptionUk,
          metaDescriptionEn: category.metaDescriptionEn,
          noindex: category.noindex,
        }}
        bounds={{
          seoMin: CONTENT_BOUNDS.seoText.min,
          seoMax: CONTENT_BOUNDS.seoText.max,
          titleMax: CONTENT_BOUNDS.metaTitle.max,
          descriptionMin: CONTENT_BOUNDS.metaDescription.min,
          descriptionMax: CONTENT_BOUNDS.metaDescription.max,
        }}
      />
    </div>
  );
}
