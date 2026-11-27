/**
 * Blog reads. The PUBLIC reads decide what is visible with the database clock (`published_at <= now()`) and per
 * language (a post has a body in one or both languages); they return only what the storefront renders. The post body is
 * Markdown at rest: it is rendered and sanitised HERE, at read time, so the database content is never trusted as html.
 */
import { sql } from 'drizzle-orm';

import type { Reader } from '@store/db/types';
import { BLOG_MAX_PAGE, BLOG_PAGE_SIZE } from '@store/shared/blog';
import {
  adminPostDto,
  adminPostRowDto,
  publicPostCardDto,
  publicPostDto,
  type AdminPostDto,
  type AdminPostRowDto,
  type PublicPostCardDto,
  type PublicPostDto,
} from '@store/shared/dto/blog';
import { serialize } from '@store/shared/dto/serialize';
import { markdownToHtml, sanitizeHtml } from '@store/shared/rich-text';

type Row = Record<string, unknown>;
type Locale = 'uk' | 'en';

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? new Date(value).toISOString() : null;
};
const col = (
  locale: Locale,
  name: 'title' | 'excerpt' | 'content' | 'meta_title' | 'meta_description',
) => sql.raw(`p.${name}_${locale}`);
/** Visible in this language: published by the database clock AND a non-blank body in that language. */
const visible = (locale: Locale) =>
  sql`p.published_at IS NOT NULL AND p.published_at <= now() AND btrim(coalesce(${col(locale, 'content')}, '')) <> ''`;

/** Markdown to safe html. A text too large or too deeply nested for the sanitiser renders as empty, never as a 500. */
export function renderPostBody(markdown: string): string {
  try {
    return sanitizeHtml(markdownToHtml(markdown));
  } catch (error) {
    if (error instanceof RangeError) return '';
    throw error;
  }
}

function toCard(row: Row): PublicPostCardDto {
  return serialize(publicPostCardDto, {
    slug: row['slug'],
    title: row['title'],
    excerpt: row['excerpt'],
    publishedAt: iso(row['published_at']),
    tags: row['tags'],
  });
}

/** `@>` (not `= ANY`): the GIN index `blog_tags_idx` serves containment only. Exported so a test can EXPLAIN it. */
export const tagFilter = (tag: string) => sql`AND p.tags @> ARRAY[${tag}]::text[]`;

export interface PostsPage {
  items: PublicPostCardDto[];
  page: number;
  totalPages: number;
  total: number;
}

export async function listPublishedPosts(
  reader: Reader,
  locale: Locale,
  options: { tag?: string | undefined; page?: number | undefined } = {},
): Promise<PostsPage> {
  const requested = options.page ?? 1;
  const page = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.trunc(requested), BLOG_MAX_PAGE))
    : 1;
  const filter = options.tag === undefined ? sql`` : tagFilter(options.tag);
  const counted = await reader.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM blog_posts p WHERE ${visible(locale)} ${filter}`,
  );
  const total = counted.rows[0]?.n ?? 0;
  const rows = await reader.execute<Row>(
    sql`SELECT p.slug, ${col(locale, 'title')} AS title, ${col(locale, 'excerpt')} AS excerpt, p.published_at, p.tags
          FROM blog_posts p WHERE ${visible(locale)} ${filter}
         ORDER BY p.published_at DESC, p.id
         LIMIT ${BLOG_PAGE_SIZE} OFFSET ${(page - 1) * BLOG_PAGE_SIZE}`,
  );
  return {
    items: rows.rows.map(toCard),
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / BLOG_PAGE_SIZE)),
  };
}

/** How many posts a list has (and so how many pages): the caller reads this BEFORE it builds a key for a page number. */
export async function countPublishedPosts(
  reader: Reader,
  locale: Locale,
  tag?: string,
): Promise<{ total: number; totalPages: number }> {
  const filter = tag === undefined ? sql`` : tagFilter(tag);
  const counted = await reader.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM blog_posts p WHERE ${visible(locale)} ${filter}`,
  );
  const total = counted.rows[0]?.n ?? 0;
  return { total, totalPages: Math.max(1, Math.ceil(total / BLOG_PAGE_SIZE)) };
}

/** The post by address in this language, or null (unknown, draft, scheduled, or no body in this language). */
export async function getPublishedPost(
  reader: Reader,
  slug: string,
  locale: Locale,
): Promise<PublicPostDto | null> {
  const rows = await reader.execute<Row>(
    sql`SELECT p.slug, ${col(locale, 'title')} AS title, ${col(locale, 'excerpt')} AS excerpt, p.published_at, p.tags,
               ${col(locale, 'content')} AS content, p.author, p.updated_at,
               ${col(locale, 'meta_title')} AS meta_title, ${col(locale, 'meta_description')} AS meta_description,
               (btrim(coalesce(p.content_uk, '')) <> '') AS has_uk, (btrim(coalesce(p.content_en, '')) <> '') AS has_en
          FROM blog_posts p WHERE p.slug = ${slug} AND ${visible(locale)}`,
  );
  const row = rows.rows[0];
  if (row === undefined) return null;
  const content = typeof row['content'] === 'string' ? row['content'] : '';
  return serialize(publicPostDto, {
    slug: row['slug'],
    title: row['title'],
    excerpt: row['excerpt'],
    publishedAt: iso(row['published_at']),
    tags: row['tags'],
    bodyHtml: renderPostBody(content),
    author: row['author'],
    updatedAt: iso(row['updated_at']),
    metaTitle: row['meta_title'],
    metaDescription: row['meta_description'],
    locales: [...(row['has_uk'] === true ? ['uk'] : []), ...(row['has_en'] === true ? ['en'] : [])],
  });
}

/** Tags of the posts visible in this language, with how many, most used first. */
export async function listPublishedTags(
  reader: Reader,
  locale: Locale,
): Promise<{ tag: string; count: number }[]> {
  const rows = await reader.execute<{ tag: string; n: number }>(
    sql`SELECT t AS tag, count(*)::int AS n FROM blog_posts p, unnest(p.tags) AS t
         WHERE ${visible(locale)} GROUP BY t ORDER BY n DESC, t LIMIT 100`,
  );
  return rows.rows.map((row) => ({ tag: row.tag, count: row.n }));
}

/**
 * `locale:slug` of every visible post, and `locale:tag:<tag>` of every tag in use: what the proxy gate admits. */
export async function listBlogGateKeys(reader: Reader): Promise<string[]> {
  const out: string[] = [];
  for (const locale of ['uk', 'en'] as const) {
    const posts = await reader.execute<{ slug: string }>(
      sql`SELECT p.slug FROM blog_posts p WHERE ${visible(locale)} LIMIT 5000`, // a bound, not a feature: a blog past 5000 visible posts per language needs a different gate
    );
    out.push(...posts.rows.map((row) => `${locale}:${row.slug}`));
    for (const { tag } of await listPublishedTags(reader, locale)) out.push(`${locale}:tag:${tag}`);
  }
  return out;
}

/** The posts for the sitemap: slug, last change, and the languages it is visible in. */
export async function listBlogForSitemap(
  reader: Reader,
): Promise<{ slug: string; lastmod: Date; locales: Locale[] }[]> {
  const rows = await reader.execute<{
    slug: string;
    lastmod: Date;
    has_uk: boolean;
    has_en: boolean;
  }>(
    sql`SELECT p.slug, p.updated_at AS lastmod,
               (${visible('uk')}) AS has_uk, (${visible('en')}) AS has_en
          FROM blog_posts p
         WHERE (${visible('uk')}) OR (${visible('en')})
         ORDER BY p.published_at DESC, p.id LIMIT 5000`,
  );
  return rows.rows.map((row) => ({
    slug: row.slug,
    lastmod: new Date(row.lastmod),
    locales: [...(row.has_uk ? (['uk'] as const) : []), ...(row.has_en ? (['en'] as const) : [])],
  }));
}

function toAdminRow(row: Row): Record<string, unknown> {
  return {
    id: row['id'],
    slug: row['slug'],
    titleUk: row['title_uk'],
    titleEn: row['title_en'],
    tags: row['tags'],
    state: row['state'],
    publishedAt: iso(row['published_at']),
    hasUk: row['has_uk'],
    hasEn: row['has_en'],
    updatedAt: iso(row['updated_at']),
  };
}
const ADMIN_COLUMNS = sql`p.*, CASE WHEN p.published_at IS NULL THEN 'draft' WHEN p.published_at > now() THEN 'scheduled' ELSE 'published' END AS state,
  (btrim(coalesce(p.content_uk, '')) <> '') AS has_uk, (btrim(coalesce(p.content_en, '')) <> '') AS has_en`;

export async function listPostsAdmin(reader: Reader): Promise<AdminPostRowDto[]> {
  const rows = await reader.execute<Row>(
    sql`SELECT ${ADMIN_COLUMNS} FROM blog_posts p ORDER BY p.updated_at DESC, p.id LIMIT 200`,
  );
  return rows.rows.map((row) => serialize(adminPostRowDto, toAdminRow(row)));
}

export async function getPostAdmin(reader: Reader, id: string): Promise<AdminPostDto | null> {
  const rows = await reader.execute<Row>(
    sql`SELECT ${ADMIN_COLUMNS} FROM blog_posts p WHERE p.id = ${id}::uuid`,
  );
  const row = rows.rows[0];
  if (row === undefined) return null;
  return serialize(adminPostDto, {
    ...toAdminRow(row),
    excerptUk: row['excerpt_uk'],
    excerptEn: row['excerpt_en'],
    contentUk: row['content_uk'],
    contentEn: row['content_en'],
    author: row['author'],
    metaTitleUk: row['meta_title_uk'],
    metaTitleEn: row['meta_title_en'],
    metaDescriptionUk: row['meta_description_uk'],
    metaDescriptionEn: row['meta_description_en'],
  });
}
