/**
 * The home-page banners, cache-safe by construction:
 *
 * - the read takes NOTHING about the visitor (no cookie, header, session or address): the result is a function of
 *   the locale and the database clock alone, so every visitor of a language gets the same bytes;
 * - the display period is decided by Postgres' `now()` when the cache is filled, and a 60 second TTL moves the
 *   result across a period boundary on its own. LIMIT: this is stale-while-revalidate and per PROCESS, so a boundary
 *   (a banner that starts or ends by the clock) is picked up within about 60 seconds of the next request after it,
 *   and with several web replicas each has its own cache. An admin change is immediate: the actions call
 *   `updateTag('banners')` (read-your-writes), the picture route expires the tag at once;
 * - the key is `['banners', locale]` over a closed set of two locales: nothing user-controlled is in a cache key;
 * - banners are rendered on the HOME page only, which is rendered per request and never stored as a page
 *   (`app/[locale]/page.tsx`); the ISR pages (product, category) carry no banner markup, so no banner change or
 *   period boundary can make an ISR page differ between visitors or go stale;
 * - a failed read keeps the last good list (empty before the first success) and logs one safe line: a database
 *   flap never breaks the home page.
 */
import { unstable_cache } from 'next/cache';

import { listActiveBanners } from '@store/core/banners';
import { BANNERS_TAG } from '@store/shared/cache-tags';
import type { PublicBannerDto } from '@store/shared/dto/banner';
import type { SiteLocale } from '@store/shared/seo';

import { getDb } from './db';
import { errorReason } from './error-reason';
import { createLastGood } from './last-good';

const BANNERS_TTL_SECONDS = 60;

const getCachedBanners = (locale: SiteLocale) =>
  unstable_cache(async () => await listActiveBanners(await getDb(), locale), ['banners', locale], {
    tags: [BANNERS_TAG],
    revalidate: BANNERS_TTL_SECONDS,
  })();

const lastGood = createLastGood<PublicBannerDto[]>();

export async function loadBanners(locale: SiteLocale): Promise<PublicBannerDto[]> {
  return await lastGood(locale, () => getCachedBanners(locale), {
    fallback: [],
    onError: (error) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'banners', reason: errorReason(error) })}\n`,
      );
    },
  });
}
