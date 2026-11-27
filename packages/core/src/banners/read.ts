/**
 * Banner reads. The PUBLIC read decides what is shown with the database clock (`now()`), never the server's, and
 * returns only what the storefront renders (`publicBannerDto`). The admin reads return the editable shape.
 */
import { sql } from 'drizzle-orm';

import type { Reader } from '@store/db/types';
import {
  adminBannerDto,
  publicBannerDto,
  type AdminBannerDto,
  type PublicBannerDto,
} from '@store/shared/dto/banner';
import { ALT_VISIBLE_CLASS } from './schemas.ts';
import { serialize } from '@store/shared/dto/serialize';

export const HOME_BANNER_LIMIT = 5;

const VISIBLE = sql.raw(`'${ALT_VISIBLE_CLASS}'`);
const SHOWN_NOW = sql`b.is_active AND b.image_desktop_url IS NOT NULL AND b.image_mobile_url IS NOT NULL
  AND coalesce(b.alt_uk, '') ~ ${VISIBLE} AND coalesce(b.alt_en, '') ~ ${VISIBLE}
  AND (b.starts_at IS NULL OR b.starts_at <= now()) AND (b.ends_at IS NULL OR b.ends_at > now())`;

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? new Date(value).toISOString() : null;
};

type Row = Record<string, unknown>;

/** Banners that are shown right now on the home page, in order. */
export async function listActiveBanners(
  reader: Reader,
  locale: 'uk' | 'en',
): Promise<PublicBannerDto[]> {
  const rows = await reader.execute<Row>(
    sql`SELECT b.* FROM banners b
         WHERE b.position = 'home_hero' AND ${SHOWN_NOW}
         ORDER BY b.sort_order, b.id LIMIT ${HOME_BANNER_LIMIT}`,
  );
  return rows.rows.map((row) => {
    const uk = locale === 'uk';
    return serialize(publicBannerDto, {
      id: row['id'],
      title: uk ? row['title_uk'] : row['title_en'],
      subtitle: uk ? row['subtitle_uk'] : row['subtitle_en'],
      ctaLabel: uk ? row['cta_label_uk'] : row['cta_label_en'],
      href: row['href'],
      alt: uk ? row['alt_uk'] : row['alt_en'],
      desktop: {
        url: row['image_desktop_url'],
        width: row['image_desktop_width'],
        height: row['image_desktop_height'],
      },
      mobile: {
        url: row['image_mobile_url'],
        width: row['image_mobile_width'],
        height: row['image_mobile_height'],
      },
    });
  });
}

function toAdmin(row: Row, shownNow: boolean): AdminBannerDto {
  const picture = (url: unknown, width: unknown, height: unknown) =>
    url === null || url === undefined ? null : { url, width, height };
  return serialize(adminBannerDto, {
    id: row['id'],
    titleUk: row['title_uk'],
    titleEn: row['title_en'],
    subtitleUk: row['subtitle_uk'],
    subtitleEn: row['subtitle_en'],
    ctaLabelUk: row['cta_label_uk'],
    ctaLabelEn: row['cta_label_en'],
    altUk: row['alt_uk'],
    altEn: row['alt_en'],
    href: row['href'],
    startsAt: iso(row['starts_at']),
    endsAt: iso(row['ends_at']),
    sortOrder: row['sort_order'],
    isActive: row['is_active'],
    desktop: picture(
      row['image_desktop_url'],
      row['image_desktop_width'],
      row['image_desktop_height'],
    ),
    mobile: picture(row['image_mobile_url'], row['image_mobile_width'], row['image_mobile_height']),
    shownNow,
    updatedAt: iso(row['updated_at']),
  });
}

export async function listBannersAdmin(reader: Reader): Promise<AdminBannerDto[]> {
  const rows = await reader.execute<Row>(
    sql`SELECT b.*, (${SHOWN_NOW}) AS shown_now FROM banners b ORDER BY b.sort_order, b.created_at, b.id LIMIT 100`,
  );
  return rows.rows.map((row) => toAdmin(row, row['shown_now'] === true));
}

export async function getBannerAdmin(reader: Reader, id: string): Promise<AdminBannerDto | null> {
  const rows = await reader.execute<Row>(
    sql`SELECT b.*, (${SHOWN_NOW}) AS shown_now FROM banners b WHERE b.id = ${id}::uuid`,
  );
  const row = rows.rows[0];
  return row === undefined ? null : toAdmin(row, row['shown_now'] === true);
}
