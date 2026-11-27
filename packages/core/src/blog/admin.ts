/**
 * Blog writes. Every function takes the transaction first. One writer per post at a time (an advisory lock on its id);
 * creation takes one lock for the slug so two creators of the same address cannot both pass. Whether a post is public is
 * decided by the DATABASE clock (`published_at <= now()`), never the server's: "publish now" writes `now()` in SQL and a
 * scheduled time is a Kyiv wall clock turned into an instant by Postgres. The body is stored as Markdown source and
 * rendered and sanitised when read.
 */
import { eq, sql } from 'drizzle-orm';

import { blogPosts } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { PostEmptyError, PostNotFoundError, PostSlugTakenError, PostTimeError } from './errors.ts';
import type { PostCreateInput, PostUpdateInput } from './schemas.ts';

const FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
const instant = (value: string | null) =>
  value === null ? sql`NULL` : sql`((${value})::timestamp AT TIME ZONE 'Europe/Kyiv')`;

async function assertRealWallClock(tx: Tx, value: string | null): Promise<void> {
  if (value === null) return;
  const result = await tx.execute<{ real: boolean }>(
    sql`SELECT ((${value})::timestamp AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv' = (${value})::timestamp AS real`,
  );
  if (result.rows[0]?.real !== true) throw new PostTimeError();
}

/** What `published_at` becomes: unpublish clears it, "now" is the database's, a time is Postgres' reading of Kyiv. */
function publicationSql(
  input: { publishNow: boolean; unpublish: boolean; publishedAt: string | null },
  current: Date | null,
) {
  // "Keep the current time" refers to the COLUMN, not to a JavaScript Date: a Date holds milliseconds, the column microseconds.
  const keep = current === null ? sql`NULL` : sql`"blog_posts"."published_at"`;
  if (input.unpublish) return sql`NULL`;
  if (input.publishNow) return current === null ? sql`now()` : keep;
  if (input.publishedAt !== null) return instant(input.publishedAt);
  return keep;
}

const hasBody = (input: { contentUk: string | null; contentEn: string | null }): boolean =>
  input.contentUk !== null || input.contentEn !== null;

export async function createPost(
  tx: Tx,
  input: PostCreateInput,
): Promise<{ id: string; slug: string }> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`blog-slug:${input.slug}`}, 0))`,
  );
  await assertRealWallClock(tx, input.publishedAt);
  const published = publicationSql(input, null);
  const wantsPublic = !input.unpublish && (input.publishNow || input.publishedAt !== null);
  if (wantsPublic && !hasBody(input)) throw new PostEmptyError();
  const inserted = await tx
    .insert(blogPosts)
    .values({
      slug: input.slug,
      titleUk: input.titleUk,
      titleEn: input.titleEn,
      excerptUk: input.excerptUk,
      excerptEn: input.excerptEn,
      contentUk: input.contentUk,
      contentEn: input.contentEn,
      author: input.author,
      tags: input.tags,
      metaTitleUk: input.metaTitleUk,
      metaTitleEn: input.metaTitleEn,
      metaDescriptionUk: input.metaDescriptionUk,
      metaDescriptionEn: input.metaDescriptionEn,
      publishedAt: sql`${published}`,
    })
    .onConflictDoNothing()
    .returning({ id: blogPosts.id, slug: blogPosts.slug });
  const row = inserted[0];
  if (row === undefined) throw new PostSlugTakenError();
  return row;
}

export interface PostChange {
  changed: boolean;
  slug: string;
  /** Name -> [before, after]; the bodies and excerpts only say "changed" (the audit never holds the text). */
  diff: Record<string, [unknown, unknown] | 'changed'>;
}

const SCALARS = [
  'titleUk',
  'titleEn',
  'author',
  'metaTitleUk',
  'metaTitleEn',
  'metaDescriptionUk',
  'metaDescriptionEn',
] as const;
const TEXTS = ['excerptUk', 'excerptEn', 'contentUk', 'contentEn'] as const;

export async function updatePost(tx: Tx, input: PostUpdateInput): Promise<PostChange> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`blog:${input.id}`}, 0))`);
  const [row] = await tx.select().from(blogPosts).where(eq(blogPosts.id, input.id));
  if (row === undefined) throw new PostNotFoundError();
  await assertRealWallClock(tx, input.publishedAt);
  const published = publicationSql(input, row.publishedAt);
  const after = await tx.execute<{ old_at: string | null; new_at: string | null; same: boolean }>(
    sql`SELECT to_char(${blogPosts.publishedAt} AT TIME ZONE 'UTC', ${FORMAT}) AS old_at,
               to_char((${published}) AT TIME ZONE 'UTC', ${FORMAT}) AS new_at,
               ${blogPosts.publishedAt} IS NOT DISTINCT FROM (${published}) AS same
          FROM blog_posts WHERE id = ${input.id}::uuid`,
  );
  const when = after.rows[0];
  const becomesPublic = when?.new_at !== null && when?.new_at !== undefined;
  const bodies = {
    contentUk: input.contentUk,
    contentEn: input.contentEn,
  };
  if (becomesPublic && !hasBody(bodies)) throw new PostEmptyError();

  const diff: PostChange['diff'] = {};
  for (const name of SCALARS) if (row[name] !== input[name]) diff[name] = [row[name], input[name]];
  for (const name of TEXTS) if (row[name] !== input[name]) diff[name] = 'changed';
  if (row.tags.join(',') !== input.tags.join(',')) diff['tags'] = [row.tags, input.tags];
  if (when?.same !== true) diff['publishedAt'] = [when?.old_at ?? null, when?.new_at ?? null];
  if (Object.keys(diff).length === 0) return { changed: false, slug: row.slug, diff };
  await tx
    .update(blogPosts)
    .set({
      titleUk: input.titleUk,
      titleEn: input.titleEn,
      excerptUk: input.excerptUk,
      excerptEn: input.excerptEn,
      contentUk: input.contentUk,
      contentEn: input.contentEn,
      author: input.author,
      tags: input.tags,
      metaTitleUk: input.metaTitleUk,
      metaTitleEn: input.metaTitleEn,
      metaDescriptionUk: input.metaDescriptionUk,
      metaDescriptionEn: input.metaDescriptionEn,
      publishedAt: sql`${published}`,
    })
    .where(eq(blogPosts.id, input.id));
  return { changed: true, slug: row.slug, diff };
}

export async function deletePost(tx: Tx, id: string): Promise<{ slug: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`blog:${id}`}, 0))`);
  const gone = await tx
    .delete(blogPosts)
    .where(eq(blogPosts.id, id))
    .returning({ slug: blogPosts.slug });
  const row = gone[0];
  if (row === undefined) throw new PostNotFoundError();
  return row;
}
