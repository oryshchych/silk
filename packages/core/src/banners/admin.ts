/**
 * Banner writes. Every function takes the transaction first. One writer per banner at a time (an advisory lock
 * on its id), so an edit and a picture upload cannot interleave: the "complete before active" rule is decided
 * under that lock from the stored pictures, and the database CHECK (`banners_active_complete`) backs it.
 * Storage keys are not stored: they are a pure function of the ids (`bannerImageKey`).
 */
import { eq, sql } from 'drizzle-orm';

import { banners } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';

import {
  BannerDatesError,
  BannerIncompleteError,
  BannerNotFoundError,
  TooManyBannersError,
} from './errors.ts';
import type { BannerCreateInput, BannerUpdateInput } from './schemas.ts';

export const MAX_BANNERS = 50;
export const BANNER_SIZES = ['thumb', 'card', 'full'] as const;
export const BANNER_FORMATS = ['webp', 'avif'] as const;

/**
 * The six storage keys behind a stored picture URL (`.../banners/<bannerId>/<imageId>/full.webp`), rebuilt from the
 * two ids in it; an empty list for anything that is not of that shape. Keys are never taken from the URL as a path.
 */
export function bannerKeysOfUrl(url: string | null): string[] {
  if (url === null) return [];
  const match = /\/banners\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/full\.webp$/.exec(url);
  const bannerId = match?.[1];
  const imageId = match?.[2];
  if (bannerId === undefined || imageId === undefined) return [];
  return BANNER_SIZES.flatMap((size) =>
    BANNER_FORMATS.map((format) => bannerImageKey(bannerId, imageId, size, format)),
  );
}

/** `banners/<bannerId>/<imageId>/<size>.<format>`: ids and fixed words only. */
export const bannerImageKey = (
  bannerId: string,
  imageId: string,
  size: (typeof BANNER_SIZES)[number],
  format: (typeof BANNER_FORMATS)[number],
): string => `banners/${bannerId}/${imageId}/${size}.${format}`;

const lock = async (tx: Tx, id: string): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`banner:${id}`}, 0))`);
};

const instant = (value: string | null) =>
  value === null ? sql`NULL` : sql`((${value})::timestamp AT TIME ZONE 'Europe/Kyiv')`;

function pgCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'cause' in error ? pgCode(error.cause) : null;
}

/** A banner is made inactive: pictures come next, and only then can it be switched on. */
export async function createBanner(tx: Tx, input: BannerCreateInput): Promise<{ id: string }> {
  // One creator at a time, so the cap below is exact (two concurrent creates cannot both pass it).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('banners:create', 0))`);
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(banners);
  if ((count?.n ?? 0) >= MAX_BANNERS) throw new TooManyBannersError();
  if (input.isActive) throw new BannerIncompleteError();
  try {
    const [row] = await tx
      .insert(banners)
      .values({
        titleUk: input.titleUk,
        titleEn: input.titleEn,
        subtitleUk: input.subtitleUk,
        subtitleEn: input.subtitleEn,
        ctaLabelUk: input.ctaLabelUk,
        ctaLabelEn: input.ctaLabelEn,
        altUk: input.altUk,
        altEn: input.altEn,
        href: input.href,
        startsAt: sql`${instant(input.startsAt)}`,
        endsAt: sql`${instant(input.endsAt)}`,
        sortOrder: input.sortOrder,
        isActive: false,
      })
      .returning({ id: banners.id });
    if (row === undefined) throw new Error('banner insert returned no row');
    return row;
  } catch (error) {
    if (pgCode(error) === '23514') throw new BannerDatesError();
    throw error;
  }
}

export interface BannerChange {
  changed: boolean;
  diff: Record<string, [unknown, unknown]>;
}

export async function updateBanner(tx: Tx, input: BannerUpdateInput): Promise<BannerChange> {
  await lock(tx, input.id);
  const [row] = await tx.select().from(banners).where(eq(banners.id, input.id));
  if (row === undefined) throw new BannerNotFoundError();
  const complete =
    row.imageDesktopUrl !== null &&
    row.imageMobileUrl !== null &&
    (input.altUk ?? '') !== '' &&
    (input.altEn ?? '') !== '';
  if (input.isActive && !complete) throw new BannerIncompleteError();

  const names = [
    'titleUk',
    'titleEn',
    'subtitleUk',
    'subtitleEn',
    'ctaLabelUk',
    'ctaLabelEn',
    'altUk',
    'altEn',
    'href',
    'sortOrder',
    'isActive',
  ] as const;
  const diff: Record<string, [unknown, unknown]> = {};
  for (const name of names) if (row[name] !== input[name]) diff[name] = [row[name], input[name]];
  // Old and new instants as ISO strings in ONE format, read in the same statement that compares them.
  const FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
  const startNew = instant(input.startsAt);
  const endNew = instant(input.endsAt);
  const dates = await tx.execute<{
    start_same: boolean;
    end_same: boolean;
    old_start: string | null;
    new_start: string | null;
    old_end: string | null;
    new_end: string | null;
  }>(
    sql`SELECT starts_at IS NOT DISTINCT FROM ${startNew} AS start_same,
               ends_at IS NOT DISTINCT FROM ${endNew} AS end_same,
               to_char(starts_at AT TIME ZONE 'UTC', ${FORMAT}) AS old_start,
               to_char(${startNew} AT TIME ZONE 'UTC', ${FORMAT}) AS new_start,
               to_char(ends_at AT TIME ZONE 'UTC', ${FORMAT}) AS old_end,
               to_char(${endNew} AT TIME ZONE 'UTC', ${FORMAT}) AS new_end
          FROM banners WHERE id = ${input.id}::uuid`,
  );
  const when = dates.rows[0];
  if (when?.start_same !== true)
    diff['startsAt'] = [when?.old_start ?? null, when?.new_start ?? null];
  if (when?.end_same !== true) diff['endsAt'] = [when?.old_end ?? null, when?.new_end ?? null];
  if (Object.keys(diff).length === 0) return { changed: false, diff };
  try {
    await tx
      .update(banners)
      .set({
        titleUk: input.titleUk,
        titleEn: input.titleEn,
        subtitleUk: input.subtitleUk,
        subtitleEn: input.subtitleEn,
        ctaLabelUk: input.ctaLabelUk,
        ctaLabelEn: input.ctaLabelEn,
        altUk: input.altUk,
        altEn: input.altEn,
        href: input.href,
        startsAt: sql`${instant(input.startsAt)}`,
        endsAt: sql`${instant(input.endsAt)}`,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      })
      .where(eq(banners.id, input.id));
  } catch (error) {
    if (pgCode(error) === '23514') throw new BannerDatesError();
    throw error;
  }
  return { changed: true, diff };
}

/** Deletes the banner and returns its stored picture URLs (their files can be removed after the commit). */
export async function deleteBanner(tx: Tx, id: string): Promise<{ urls: string[] }> {
  await lock(tx, id);
  const gone = await tx
    .delete(banners)
    .where(eq(banners.id, id))
    .returning({ desktop: banners.imageDesktopUrl, mobile: banners.imageMobileUrl });
  const row = gone[0];
  if (row === undefined) throw new BannerNotFoundError();
  return { urls: [row.desktop, row.mobile].filter((url): url is string => url !== null) };
}

/** False when there is no such banner (checked BEFORE a picture is converted, not after). */
export async function bannerExists(db: Reader, id: string): Promise<boolean> {
  const [row] = await db.select({ id: banners.id }).from(banners).where(eq(banners.id, id));
  return row !== undefined;
}

/** Puts a picture in a slot. Returns the previous URL (its files can be removed after the commit). */
export async function setBannerImage(
  tx: Tx,
  input: {
    bannerId: string;
    slot: 'desktop' | 'mobile';
    url: string;
    width: number;
    height: number;
  },
): Promise<{ previousUrl: string | null }> {
  await lock(tx, input.bannerId);
  const [row] = await tx.select().from(banners).where(eq(banners.id, input.bannerId));
  if (row === undefined) throw new BannerNotFoundError();
  const previousUrl = input.slot === 'desktop' ? row.imageDesktopUrl : row.imageMobileUrl;
  await tx
    .update(banners)
    .set(
      input.slot === 'desktop'
        ? {
            imageDesktopUrl: input.url,
            imageDesktopWidth: input.width,
            imageDesktopHeight: input.height,
          }
        : {
            imageMobileUrl: input.url,
            imageMobileWidth: input.width,
            imageMobileHeight: input.height,
          },
    )
    .where(eq(banners.id, input.bannerId));
  return { previousUrl };
}
