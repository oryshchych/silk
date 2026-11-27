import { getPostAdmin } from '@store/core/blog';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { PostForm } from '@/components/admin/post-form';
import { toKyivLocalInput } from '@/lib/admin/kyiv-time';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('blog.edit');
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.blog' });
  const post = await getPostAdmin(await getDb(), id.data);
  if (post === null) notFound();
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('editTitle')}</h1>
      <div className="mt-4">
        <PostForm existing={{ post, publishedAtLocal: toKyivLocalInput(post.publishedAt) }} />
      </div>
    </div>
  );
}
