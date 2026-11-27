/**
 * The pre-generated renditions of an uploaded photo (`packages/media`): WebP and AVIF at 320, 800
 * and 1600 pixels, stored under keys that are a pure function of the ids
 * (`products/<productId>/<imageId>/<size>.<format>`, and the same shape under `banners/<bannerId>/`). The photo's `url` is the full WebP, so its
 * siblings are derived from it without any new column. A URL that is not of that shape (the seed
 * placeholder, a legacy address) has no renditions and is shown as it is.
 *
 * A `w` descriptor must be the REAL width of the file. The converter fits the source inside
 * 1600 x 1600 first, so a portrait photo is narrower than its nominal size: the widths come from
 * the same function the converter's numbers come from (`@store/media/widths`).
 */
import { renditionWidth, type RenditionSize } from '@store/media/widths';

const SIZES: readonly RenditionSize[] = ['thumb', 'card', 'full'];

const FULL_WEBP =
  /^(https:\/\/[^/\s?#]+(?:\/[^/\s?#]+)*\/(?:products|banners)\/[0-9a-f-]{36}\/[0-9a-f-]{36})\/full\.webp$/;

export interface RenditionSources {
  avif: string;
  webp: string;
}

/**
 * `srcset` strings per format, from the source's stored dimensions; duplicate widths are dropped
 * (a 700 px photo has two sizes, not three). Null when the URL is not an upload or a dimension is
 * unknown.
 */
export function renditionSources(
  url: string,
  sourceWidth: number | null,
  sourceHeight: number | null,
): RenditionSources | null {
  const base = FULL_WEBP.exec(url)?.[1];
  if (
    base === undefined ||
    sourceWidth === null ||
    sourceHeight === null ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return null;
  }
  const build = (format: 'avif' | 'webp'): string => {
    const seen = new Set<number>();
    const parts: string[] = [];
    for (const size of SIZES) {
      const width = renditionWidth(size, sourceWidth, sourceHeight);
      if (seen.has(width)) continue;
      seen.add(width);
      parts.push(`${base}/${size}.${format} ${String(width)}w`);
    }
    return parts.join(', ');
  };
  return { avif: build('avif'), webp: build('webp') };
}
