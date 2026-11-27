import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { PostForm } from '@/components/admin/post-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';

export default async function NewPostPage() {
  await requirePermission('blog.edit');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.blog' });
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('createTitle')}</h1>
      <div className="mt-4">
        <PostForm />
      </div>
    </div>
  );
}
