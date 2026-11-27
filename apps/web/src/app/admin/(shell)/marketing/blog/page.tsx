import { listPostsAdmin } from '@store/core/blog';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { formatWhen } from '@/lib/admin/format';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

/** The posts, newest change first, with their state decided by the database clock. */
export default async function BlogAdminPage() {
  await requirePermission('blog.edit');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.blog' });
  const posts = await listPostsAdmin(await getDb());
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-2 max-w-2xl text-text-muted">{t('intro')}</p>
      <p className="mt-3">
        <a href="/admin/marketing/blog/new" className="inline-flex min-h-11 items-center underline">
          {t('create')}
        </a>
      </p>
      {posts.length === 0 ? <p className="mt-4">{t('empty')}</p> : null}
      <ul className="mt-4 flex flex-col gap-3">
        {posts.map((post) => (
          <li key={post.id} className="rounded-md border border-border p-3">
            <a
              href={`/admin/marketing/blog/${post.id}`}
              className="inline-flex min-h-11 items-center underline"
            >
              {locale === 'en' ? post.titleEn : post.titleUk}
            </a>
            <p className="text-sm text-text-muted">
              {t(`states.${post.state}`)}
              {post.publishedAt === null ? '' : ` · ${formatWhen(post.publishedAt, locale)}`}
              {` · ${post.hasUk ? 'UK' : '—'} ${post.hasEn ? 'EN' : '—'}`}
              {post.tags.length === 0 ? '' : ` · ${post.tags.join(', ')}`}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
