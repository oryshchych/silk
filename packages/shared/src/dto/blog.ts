/**
 * Blog DTOs. The PUBLIC shapes hold what the storefront renders and nothing else (no draft flag, no other language, no
 * author account). Explicit field lists; the admin shape adds what the editor changes.
 */
import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });

export const publicPostCardDto = z.object({
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  publishedAt: instant,
  tags: z.array(z.string()),
});
export type PublicPostCardDto = z.output<typeof publicPostCardDto>;

export const publicPostDto = publicPostCardDto.extend({
  /** Sanitised html of the post, rendered from the stored Markdown at read time. */
  bodyHtml: z.string(),
  author: z.string().nullable(),
  updatedAt: instant,
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  /** The languages this post has a body in (a hreflang pair exists only when both are here). */
  locales: z.array(z.enum(['uk', 'en'])),
});
export type PublicPostDto = z.output<typeof publicPostDto>;

export const adminPostRowDto = z.object({
  id: z.uuid(),
  slug: z.string(),
  titleUk: z.string(),
  titleEn: z.string(),
  tags: z.array(z.string()),
  /** Draft, scheduled (a future time) or published, decided by the database clock. */
  state: z.enum(['draft', 'scheduled', 'published']),
  publishedAt: instant.nullable(),
  hasUk: z.boolean(),
  hasEn: z.boolean(),
  updatedAt: instant,
});
export type AdminPostRowDto = z.output<typeof adminPostRowDto>;

export const adminPostDto = adminPostRowDto.extend({
  excerptUk: z.string().nullable(),
  excerptEn: z.string().nullable(),
  contentUk: z.string().nullable(),
  contentEn: z.string().nullable(),
  author: z.string().nullable(),
  metaTitleUk: z.string().nullable(),
  metaTitleEn: z.string().nullable(),
  metaDescriptionUk: z.string().nullable(),
  metaDescriptionEn: z.string().nullable(),
});
export type AdminPostDto = z.output<typeof adminPostDto>;
