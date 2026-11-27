/**
 * Input of the banner admin: the allowlist of what an action can set. Text is stripped of control and invisible
 * characters; the link is a path on THIS shop (`/category/bras`), never an address elsewhere; times arrive as Kyiv
 * wall-clock text and are turned into instants by Postgres.
 */
import { z } from 'zod';

import { cleanText } from '@store/shared/content-text';

const text = (max: number) =>
  z
    .string()
    .refine((value) => !value.includes('\u0000'))
    .overwrite(cleanText)
    .trim()
    .max(max)
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

/** A path on this shop: starts with one slash and a letter or digit, no scheme, no `//`, no whitespace. */
export const internalPath = z
  .string()
  .trim()
  .max(300)
  .transform((value) => (value === '' ? null : value))
  .pipe(
    z
      .string()
      .regex(/^\/[A-Za-z0-9][A-Za-z0-9\-._~/%?=&#]*$/)
      .nullable(),
  );

const fields = z.object({
  titleUk: text(200),
  titleEn: text(200),
  subtitleUk: text(300),
  subtitleEn: text(300),
  ctaLabelUk: text(80),
  ctaLabelEn: text(80),
  altUk: text(300),
  altEn: text(300),
  href: internalPath,
  startsAt: wallClock,
  endsAt: wallClock,
  sortOrder: z
    .string()
    .regex(/^-?\d{1,5}$/)
    .transform(Number),
  isActive: z.boolean(),
});

const ordered = (
  input: { startsAt: string | null; endsAt: string | null },
  ctx: z.RefinementCtx,
) => {
  if (input.startsAt !== null && input.endsAt !== null && input.startsAt >= input.endsAt) {
    ctx.addIssue({ code: 'custom', message: 'the end must be after the start' });
  }
};

export const bannerCreateSchema = fields.superRefine(ordered);
export type BannerCreateInput = z.output<typeof bannerCreateSchema>;
export const bannerUpdateSchema = fields.extend({ id: z.uuid() }).superRefine(ordered);
export type BannerUpdateInput = z.output<typeof bannerUpdateSchema>;
export const bannerIdSchema = z.object({ id: z.uuid() });
export const bannerImageQuerySchema = z.object({
  bannerId: z.uuid().transform((value) => value.toLowerCase()),
  slot: z.enum(['desktop', 'mobile']),
});
