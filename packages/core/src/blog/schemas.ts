/**
 * Input of the blog admin: the allowlist of what an action can set. Text is cleaned of control and invisible
 * characters; the body is Markdown (rendered and sanitised at READ time, so what is stored is never trusted as html);
 * tags are words joined by hyphens, deduplicated and at most ten; the publication time is Kyiv wall-clock text turned
 * into an instant by Postgres. The address (slug) is set ONCE, at creation: it is a public URL, and a rename would need
 * redirects in both languages.
 */
import { z } from 'zod';

import { BLOG_MAX_TAGS, BLOG_SLUG, BLOG_SLUG_MAX, BLOG_TAG_MAX } from '@store/shared/blog';
import { cleanText } from '@store/shared/content-text';
import { MAX_RICH_TEXT_CHARS } from '@store/shared/rich-text';

const line = (max: number) =>
  z
    .string()
    .refine((value) => !value.includes('\u0000'))
    .overwrite(cleanText)
    .trim()
    .max(max);
const optionalLine = (max: number) => line(max).transform((value) => (value === '' ? null : value));

/** A Markdown body keeps its line breaks: only NUL and the invisible controls other than LF and tab are dropped. */
const body = z
  .string()
  .max(MAX_RICH_TEXT_CHARS)
  .refine((value) => !value.includes('\u0000'))
  .transform((value) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim())
  .transform((value) => (value === '' ? null : value));

const wallClock = z
  .union([z.literal(''), z.null(), z.string()])
  .transform((value) => (value === '' || value === null ? null : value))
  .pipe(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/)
      .refine((value) => {
        const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
        return (
          !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10)
        );
      })
      .nullable(),
  );

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (value) => value.length <= BLOG_TAG_MAX && BLOG_SLUG.test(value),
    'a tag is lower-case words joined by hyphens',
  );

/** `bras, care-tips` as typed in a form field, or an array: deduplicated, at most ten. */
const tags = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  )
  .pipe(z.array(tag).max(BLOG_MAX_TAGS))
  .transform((list) => [...new Set(list)]);

const fields = {
  titleUk: line(300).pipe(z.string().min(1)),
  titleEn: line(300).pipe(z.string().min(1)),
  excerptUk: optionalLine(500),
  excerptEn: optionalLine(500),
  contentUk: body,
  contentEn: body,
  author: optionalLine(160),
  tags,
  metaTitleUk: optionalLine(200),
  metaTitleEn: optionalLine(200),
  metaDescriptionUk: optionalLine(400),
  metaDescriptionEn: optionalLine(400),
  /** A time in Kyiv, or empty. With "publish now" it is ignored while the post is not yet published. */
  publishedAt: wallClock,
  publishNow: z.boolean(),
  /** Back to a draft (clears the publication time). */
  unpublish: z.boolean(),
};

const slug = z
  .string()
  .trim()
  .max(BLOG_SLUG_MAX)
  .refine((value) => BLOG_SLUG.test(value), 'lower-case words joined by hyphens');

export const postCreateSchema = z.object({ slug, ...fields });
export type PostCreateInput = z.output<typeof postCreateSchema>;
export const postUpdateSchema = z.object({ id: z.uuid(), ...fields });
export type PostUpdateInput = z.output<typeof postUpdateSchema>;
export const postIdSchema = z.object({ id: z.uuid() });
