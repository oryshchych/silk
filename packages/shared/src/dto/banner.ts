/**
 * Banner DTOs. The PUBLIC shape is what the storefront renders and nothing else: no id of the author, no flag, no
 * period, no other language. The admin shape adds what the screen edits. Both are explicit field lists.
 */
import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });

const picture = z.object({
  url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const publicBannerDto = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  ctaLabel: z.string().nullable(),
  href: z.string().nullable(),
  alt: z.string(),
  desktop: picture,
  mobile: picture,
});
export type PublicBannerDto = z.output<typeof publicBannerDto>;

export const adminBannerDto = z.object({
  id: z.uuid(),
  titleUk: z.string().nullable(),
  titleEn: z.string().nullable(),
  subtitleUk: z.string().nullable(),
  subtitleEn: z.string().nullable(),
  ctaLabelUk: z.string().nullable(),
  ctaLabelEn: z.string().nullable(),
  altUk: z.string().nullable(),
  altEn: z.string().nullable(),
  href: z.string().nullable(),
  startsAt: instant.nullable(),
  endsAt: instant.nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  desktop: picture.nullable(),
  mobile: picture.nullable(),
  /** Decided by the database clock: active, complete and inside the period right now. */
  shownNow: z.boolean(),
  updatedAt: instant,
});
export type AdminBannerDto = z.output<typeof adminBannerDto>;
