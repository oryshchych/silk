'use client';

import { blogPostPath } from '@store/shared/blog';
import type { AdminPostDto } from '@store/shared/dto/blog';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { createPostAction, deletePostAction, updatePostAction } from '@/actions/admin-blog';

import { buttonClass } from './auth-card';
import { StatusLine, TextArea, TextField } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const F = {
  slug: 'slug',
  titleUk: 'titleUk',
  titleEn: 'titleEn',
  excerptUk: 'excerptUk',
  excerptEn: 'excerptEn',
  contentUk: 'contentUk',
  contentEn: 'contentEn',
  author: 'author',
  tags: 'tags',
  metaTitleUk: 'metaTitleUk',
  metaTitleEn: 'metaTitleEn',
  metaDescriptionUk: 'metaDescriptionUk',
  metaDescriptionEn: 'metaDescriptionEn',
  publishedAt: 'publishedAt',
} as const;

const SUBMIT_SAVE = 'save';
const SUBMIT_PUBLISH = 'publish';
const SUBMIT_UNPUBLISH = 'unpublish';

export function PostForm({
  existing,
}: {
  existing?: { post: AdminPostDto; publishedAtLocal: string };
}) {
  const t = useTranslations('admin.blog');
  const router = useRouter();
  const { message, pending, run } = useAdminAction();
  const post = existing?.post;
  return (
    <form
      className="flex max-w-3xl flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = readForm(event.currentTarget);
        const submitter =
          event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
        const action = submitter instanceof HTMLButtonElement ? submitter.value : '';
        const body = {
          titleUk: textOf(data, F.titleUk),
          titleEn: textOf(data, F.titleEn),
          excerptUk: textOf(data, F.excerptUk),
          excerptEn: textOf(data, F.excerptEn),
          contentUk: textOf(data, F.contentUk),
          contentEn: textOf(data, F.contentEn),
          author: textOf(data, F.author),
          tags: textOf(data, F.tags),
          metaTitleUk: textOf(data, F.metaTitleUk),
          metaTitleEn: textOf(data, F.metaTitleEn),
          metaDescriptionUk: textOf(data, F.metaDescriptionUk),
          metaDescriptionEn: textOf(data, F.metaDescriptionEn),
          publishedAt: textOf(data, F.publishedAt),
          publishNow: action === SUBMIT_PUBLISH,
          unpublish: action === SUBMIT_UNPUBLISH,
        };
        let createdId: string | null = null;
        run(
          async () => {
            if (post !== undefined) return await updatePostAction({ ...body, id: post.id });
            const created = await createPostAction({ ...body, slug: textOf(data, F.slug) });
            if (created.ok) createdId = created.data.id;
            return created;
          },
          t('saved'),
          () => {
            if (post === undefined) {
              router.push(
                createdId === null ? '/admin/marketing/blog' : `/admin/marketing/blog/${createdId}`,
              );
            } else {
              router.refresh();
            }
          },
        );
      }}
    >
      {post === undefined ? (
        <TextField
          label={t('fields.slug')}
          name={F.slug}
          hint={t('slugHint')}
          maxLength={120}
          required
        />
      ) : (
        <p>
          <strong>{blogPostPath(post.slug)}</strong> · {t(`states.${post.state}`)}
        </p>
      )}
      <TextField
        label={t('fields.titleUk')}
        name={F.titleUk}
        defaultValue={post?.titleUk}
        maxLength={300}
        required
      />
      <TextField
        label={t('fields.titleEn')}
        name={F.titleEn}
        defaultValue={post?.titleEn}
        maxLength={300}
        required
      />
      <TextArea
        label={t('fields.excerptUk')}
        name={F.excerptUk}
        defaultValue={post?.excerptUk}
        maxLength={500}
        rows={3}
      />
      <TextArea
        label={t('fields.excerptEn')}
        name={F.excerptEn}
        defaultValue={post?.excerptEn}
        maxLength={500}
        rows={3}
      />
      <TextArea
        label={t('fields.contentUk')}
        name={F.contentUk}
        hint={t('markdownHint')}
        defaultValue={post?.contentUk}
        rows={14}
      />
      <TextArea
        label={t('fields.contentEn')}
        name={F.contentEn}
        hint={t('markdownHint')}
        defaultValue={post?.contentEn}
        rows={14}
      />
      <TextField
        label={t('fields.author')}
        name={F.author}
        defaultValue={post?.author}
        maxLength={160}
      />
      <TextField
        label={t('fields.tags')}
        name={F.tags}
        hint={t('tagsHint')}
        defaultValue={post?.tags.join(', ')}
        maxLength={450}
      />
      <TextField
        label={t('fields.metaTitleUk')}
        name={F.metaTitleUk}
        defaultValue={post?.metaTitleUk}
        maxLength={200}
      />
      <TextField
        label={t('fields.metaTitleEn')}
        name={F.metaTitleEn}
        defaultValue={post?.metaTitleEn}
        maxLength={200}
      />
      <TextArea
        label={t('fields.metaDescriptionUk')}
        name={F.metaDescriptionUk}
        defaultValue={post?.metaDescriptionUk}
        maxLength={400}
        rows={2}
      />
      <TextArea
        label={t('fields.metaDescriptionEn')}
        name={F.metaDescriptionEn}
        defaultValue={post?.metaDescriptionEn}
        maxLength={400}
        rows={2}
      />
      <label className="block">
        {t('fields.publishedAt')}
        <input
          type="datetime-local"
          name={F.publishedAt}
          defaultValue={existing?.publishedAtLocal ?? ''}
          className="mt-1 block min-h-11 w-full rounded-md border border-border px-3"
        />
        <span className="mt-1 block text-sm text-text-muted">{t('publishedAtHint')}</span>
      </label>
      <div className="flex flex-wrap gap-3">
        <button type="submit" value={SUBMIT_SAVE} disabled={pending} className={buttonClass}>
          {t('save')}
        </button>
        <button type="submit" value={SUBMIT_PUBLISH} disabled={pending} className={buttonClass}>
          {t('publishNow')}
        </button>
        {post === undefined || post.state === 'draft' ? null : (
          <button type="submit" value={SUBMIT_UNPUBLISH} disabled={pending} className={buttonClass}>
            {t('unpublish')}
          </button>
        )}
        {post === undefined ? null : (
          <button
            type="button"
            disabled={pending}
            className={buttonClass}
            onClick={() => {
              if (!window.confirm(t('confirmDelete'))) return;
              run(
                async () => await deletePostAction({ id: post.id }),
                t('deleted'),
                () => {
                  router.push('/admin/marketing/blog');
                },
              );
            }}
          >
            {t('delete')}
          </button>
        )}
      </div>
      <StatusLine message={message} />
    </form>
  );
}
