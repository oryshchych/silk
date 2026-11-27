/**
 * The blog on real Postgres (phase 11, slice E1): drafts, scheduling and publishing decided by the database clock, a post
 * visible per language, tags normalised and filtered, the address set once and unique under a race, the audit diff that
 * never holds the text, and the body rendered and sanitised at read time.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import {
  createPost,
  deletePost,
  getPostAdmin,
  getPublishedPost,
  listBlogForSitemap,
  listBlogGateKeys,
  listPostsAdmin,
  listPublishedPosts,
  listPublishedTags,
  PostEmptyError,
  PostSlugTakenError,
  PostTimeError,
  postCreateSchema,
  postUpdateSchema,
  renderPostBody,
  updatePost,
} from '../src/blog/index.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
});
afterEach(async () => {
  await world.close();
});

const form = (overrides: Record<string, unknown> = {}) => ({
  slug: 'how-to-choose-a-bra',
  titleUk: 'Як обрати бюстгальтер',
  titleEn: 'How to choose a bra',
  excerptUk: '',
  excerptEn: '',
  contentUk: '## Розмір\n\nВимірюйте **двічі**.',
  contentEn: '## Size\n\nMeasure **twice**.',
  author: '',
  tags: 'bras, fit-guide',
  metaTitleUk: '',
  metaTitleEn: '',
  metaDescriptionUk: '',
  metaDescriptionEn: '',
  publishedAt: '',
  publishNow: false,
  unpublish: false,
  ...overrides,
});
const create = async (overrides: Record<string, unknown> = {}) =>
  await admin.db.transaction(
    async (tx) => await createPost(tx, postCreateSchema.parse(form(overrides))),
  );
const update = async (id: string, overrides: Record<string, unknown> = {}) => {
  const rest: Record<string, unknown> = form(overrides);
  delete rest['slug'];
  return await admin.db.transaction(
    async (tx) => await updatePost(tx, postUpdateSchema.parse({ ...rest, id })),
  );
};

describe('input', () => {
  it('tags are words joined by hyphens, deduplicated, lower-cased, at most ten; the slug is checked', () => {
    expect(postCreateSchema.parse(form({ tags: 'Bras, bras ,  care-tips,' })).tags).toEqual([
      'bras',
      'care-tips',
    ]);
    expect(postCreateSchema.safeParse(form({ tags: 'two words' })).success).toBe(false);
    expect(postCreateSchema.safeParse(form({ tags: 'a,b,c,d,e,f,g,h,i,j,k' })).success).toBe(false);
    for (const slug of ['Upper', 'a b', 'a--b', '-a', 'a/b', '']) {
      expect(postCreateSchema.safeParse(form({ slug })).success, slug).toBe(false);
    }
    expect(postCreateSchema.parse(form({ contentUk: '   ' })).contentUk).toBeNull();
  });
});

describe('visibility', () => {
  it('a draft and a scheduled post are invisible; publishing makes them visible by the database clock', async () => {
    const draft = await create({ slug: 'draft-post' });
    await create({ slug: 'scheduled-post', publishedAt: '2099-01-01T10:00' });
    expect((await listPublishedPosts(admin.db, 'uk')).total).toBe(0);
    expect(await getPublishedPost(admin.db, 'draft-post', 'uk')).toBeNull();
    const states = (await listPostsAdmin(admin.db)).map((p) => [p.slug, p.state]).sort();
    expect(states).toEqual([
      ['draft-post', 'draft'],
      ['scheduled-post', 'scheduled'],
    ]);
    await update(draft.id, { publishNow: true });
    expect((await getPublishedPost(admin.db, 'draft-post', 'uk'))?.title).toBe(
      'Як обрати бюстгальтер',
    );
    // A scheduled time that passes (by Postgres' now()) makes the post visible without any write.
    await admin.db.execute(
      sql`UPDATE blog_posts SET published_at = now() - interval '1 second' WHERE slug = 'scheduled-post'`,
    );
    expect((await listPublishedPosts(admin.db, 'uk')).total).toBe(2);
  });

  it('a post is visible only in a language it has a body in; the hreflang languages say which', async () => {
    await create({ slug: 'uk-only', contentEn: '', publishNow: true });
    await create({ slug: 'both', publishNow: true });
    expect((await listPublishedPosts(admin.db, 'en')).items.map((p) => p.slug)).toEqual(['both']);
    expect((await listPublishedPosts(admin.db, 'uk')).total).toBe(2);
    expect(await getPublishedPost(admin.db, 'uk-only', 'en')).toBeNull();
    expect((await getPublishedPost(admin.db, 'uk-only', 'uk'))?.locales).toEqual(['uk']);
    expect((await getPublishedPost(admin.db, 'both', 'en'))?.locales).toEqual(['uk', 'en']);
    expect((await listBlogGateKeys(admin.db)).sort()).toEqual(
      [
        'en:both',
        'en:tag:bras',
        'en:tag:fit-guide',
        'uk:both',
        'uk:tag:bras',
        'uk:tag:fit-guide',
        'uk:uk-only',
      ].sort(),
    );
    const sitemap = await listBlogForSitemap(admin.db);
    expect(Object.fromEntries(sitemap.map((p) => [p.slug, p.locales]))).toEqual({
      both: ['uk', 'en'],
      'uk-only': ['uk'],
    });
  });

  it('publishing needs a body in at least one language, and a time that does not exist is refused', async () => {
    await expect(
      create({ slug: 'empty', contentUk: '', contentEn: '', publishNow: true }),
    ).rejects.toBeInstanceOf(PostEmptyError);
    const draft = await create({ slug: 'empty-draft', contentUk: '', contentEn: '' });
    await expect(
      update(draft.id, { contentUk: '', contentEn: '', publishNow: true }),
    ).rejects.toBeInstanceOf(PostEmptyError);
    await expect(
      create({ slug: 'skipped', publishedAt: '2026-03-29T03:30' }),
    ).rejects.toBeInstanceOf(PostTimeError);
  });

  it('unpublishing returns a post to a draft; publishing twice keeps the first time', async () => {
    const post = await create({ slug: 'cycle', publishNow: true });
    const first = (await getPostAdmin(admin.db, post.id))?.publishedAt;
    await admin.db.execute(sql`SELECT pg_sleep(0.05)`);
    expect((await update(post.id, { publishNow: true })).changed).toBe(false);
    expect((await getPostAdmin(admin.db, post.id))?.publishedAt).toBe(first);
    expect((await update(post.id, { unpublish: true })).changed).toBe(true);
    expect((await getPostAdmin(admin.db, post.id))?.state).toBe('draft');
    expect(await getPublishedPost(admin.db, 'cycle', 'uk')).toBeNull();
  });
});

describe('listing, tags and paging', () => {
  it('filters by tag, counts tags per language, orders newest first and pages', async () => {
    for (let i = 0; i < 14; i += 1) {
      await create({
        slug: `post-${String(i)}`,
        tags: i % 2 === 0 ? 'even, all' : 'odd, all',
        publishNow: true,
      });
      await admin.db.execute(
        sql`UPDATE blog_posts SET published_at = now() - make_interval(mins => ${14 - i}) WHERE slug = ${`post-${String(i)}`}`,
      );
    }
    const first = await listPublishedPosts(admin.db, 'uk');
    expect([first.items.length, first.total, first.totalPages]).toEqual([12, 14, 2]);
    expect(first.items[0]?.slug).toBe('post-13');
    expect(
      (await listPublishedPosts(admin.db, 'uk', { page: 2 })).items.map((p) => p.slug),
    ).toEqual(['post-1', 'post-0']);
    expect((await listPublishedPosts(admin.db, 'uk', { tag: 'even' })).total).toBe(7);
    expect((await listPublishedPosts(admin.db, 'uk', { tag: 'nothing' })).total).toBe(0);
    expect((await listPublishedPosts(admin.db, 'uk', { page: -5 })).page).toBe(1);
    expect((await listPublishedTags(admin.db, 'uk')).slice(0, 1)).toEqual([
      { tag: 'all', count: 14 },
    ]);
  });
});

describe('writes', () => {
  it('the address is unique and set once: two creators racing for it make one post', async () => {
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await handle.db.transaction(
        async (tx) => await createPost(tx, postCreateSchema.parse(form())),
      );
    };
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(PostSlugTakenError);
  });

  it('the diff never holds the text: a body change says "changed", a title change holds both values', async () => {
    const post = await create({ slug: 'diffs' });
    const changed = await update(post.id, { contentUk: 'SECRET draft text', titleEn: 'New title' });
    expect(changed.diff['contentUk']).toBe('changed');
    expect(changed.diff['titleEn']).toEqual(['How to choose a bra', 'New title']);
    expect(JSON.stringify(changed.diff)).not.toContain('SECRET');
    expect(
      (await update(post.id, { contentUk: 'SECRET draft text', titleEn: 'New title' })).changed,
    ).toBe(false);
  });

  it('delete removes the post; an unknown one is refused', async () => {
    const post = await create({ slug: 'to-delete', publishNow: true });
    await admin.db.transaction(async (tx) => {
      await deletePost(tx, post.id);
    });
    expect(await getPublishedPost(admin.db, 'to-delete', 'uk')).toBeNull();
    await expect(
      admin.db.transaction(async (tx) => await deletePost(tx, post.id)),
    ).rejects.toThrow();
  });
});

describe('the body is rendered and sanitised at read time', () => {
  it('markdown becomes safe html; script, handlers and javascript: links never survive', () => {
    const html = renderPostBody(
      '## Title\n\nText with <script>alert(1)</script> and <img src=x onerror=alert(2)> and [bad](javascript:alert(3)) and [good](https://example.com/page).',
    );
    expect(html).toContain('<h2>');
    expect(html).not.toMatch(/<script|<img|href="javascript|<[a-z]+[^>]*\son\w+=/i);
    expect(html).toContain('href="https://example.com/page"');
  });

  it('what the database holds is never trusted: hostile html stored as the body comes out inert', async () => {
    const post = await create({
      slug: 'hostile',
      publishNow: true,
      contentUk: '<script>window.x=1</script><p onclick="x()">hi</p>',
    });
    const read = await getPublishedPost(admin.db, 'hostile', 'uk');
    expect(read?.bodyHtml).not.toMatch(/<script|<[a-z]+[^>]*\son\w+=/i);
    expect(post.slug).toBe('hostile');
  });

  it('a body too large for the sanitiser renders empty, never an error', () => {
    expect(renderPostBody('a'.repeat(300_000))).toBe('');
  });
});
