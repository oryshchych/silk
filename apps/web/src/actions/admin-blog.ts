'use server';

import {
  createPost,
  deletePost,
  postCreateSchema,
  postIdSchema,
  postUpdateSchema,
  updatePost,
} from '@store/core/blog';
import { BLOG_TAG, blogPostTag } from '@store/shared/cache-tags';

import { adminAction } from '@/lib/admin/bound-action';
import { updateTags } from '@/lib/admin/invalidate';
import { knownBlogPages } from '@/lib/blog-gate';

/**
 * Blog posts. Every action names `blog.edit`, checked by `adminAction` BEFORE the input is parsed; the audit row is
 * written in the same transaction and never holds the text (a body or an excerpt is recorded as "changed"). The cached blog
 * pages and the proxy's set of known addresses are dropped only AFTER the commit, and only when something changed
 * (`updateTag`: the very next request reads fresh data).
 */
function expire(slug: string): void {
  updateTags([BLOG_TAG, blogPostTag(slug)]);
  knownBlogPages.invalidate();
}

export async function createPostAction(input: unknown) {
  const result = await adminAction({
    permission: 'blog.edit',
    schema: postCreateSchema,
    input,
    run: async ({ tx, input: parsed, audit }) => {
      const created = await createPost(tx, parsed);
      await audit({
        action: 'blog.created',
        entity: 'blog_post',
        entityId: created.id,
        diff: {
          slug: created.slug,
          tags: parsed.tags,
          published: parsed.publishNow || parsed.publishedAt !== null,
        },
      });
      return created;
    },
  });
  if (result.ok) expire(result.data.slug);
  return result;
}

export async function updatePostAction(input: unknown) {
  const result = await adminAction({
    permission: 'blog.edit',
    schema: postUpdateSchema,
    input,
    run: async ({ tx, input: parsed, audit, skipAudit }) => {
      const done = await updatePost(tx, parsed);
      if (!done.changed) {
        skipAudit();
        return { id: parsed.id, slug: done.slug, changed: false };
      }
      await audit({
        action: 'blog.updated',
        entity: 'blog_post',
        entityId: parsed.id,
        diff: done.diff,
      });
      return { id: parsed.id, slug: done.slug, changed: true };
    },
  });
  if (result.ok && result.data.changed) expire(result.data.slug);
  return result;
}

export async function deletePostAction(input: unknown) {
  const result = await adminAction({
    permission: 'blog.edit',
    schema: postIdSchema,
    input,
    run: async ({ tx, input: parsed, audit }) => {
      const gone = await deletePost(tx, parsed.id);
      await audit({
        action: 'blog.deleted',
        entity: 'blog_post',
        entityId: parsed.id,
        diff: { slug: gone.slug },
      });
      return { id: parsed.id, slug: gone.slug };
    },
  });
  if (result.ok) expire(result.data.slug);
  return result;
}
