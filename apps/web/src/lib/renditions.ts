/**
 * The pre-generated renditions of an uploaded photo (`packages/media`): WebP and AVIF at 320, 800
 * and 1600 pixels, stored under keys that are a pure function of the ids
 * (`products/<productId>/<imageId>/<size>.<format>`). The photo's `url` is the full WebP, so its
 * siblings are derived from it without any new column. A URL that is not of that shape (the seed
 * placeholder, a legacy address) has no renditions and is shown as it is.
 */
const WIDTHS = [
  ['thumb', 320],
  ['card', 800],
  ['full', 1600],
] as const;

const FULL_WEBP =
  /^(https:\/\/[^/\s?#]+(?:\/[^/\s?#]+)*\/products\/[0-9a-f-]{36}\/[0-9a-f-]{36})\/full\.webp$/;

export interface RenditionSources {
  avif: string;
  webp: string;
}

/**
 * `srcset` strings per format. A rendition is never wider than the source, so a width descriptor
 * is `min(size, sourceWidth)` and duplicates are dropped (a 700 px photo has one size, not three).
 * Null when the URL is not an upload or the source width is unknown.
 */
export function renditionSources(url: string, sourceWidth: number | null): RenditionSources | null {
  const base = FULL_WEBP.exec(url)?.[1];
  if (base === undefined || sourceWidth === null || sourceWidth <= 0) return null;
  const build = (format: 'avif' | 'webp'): string => {
    const seen = new Set<number>();
    const parts: string[] = [];
    for (const [size, target] of WIDTHS) {
      const width = Math.min(target, sourceWidth);
      if (seen.has(width)) continue;
      seen.add(width);
      parts.push(`${base}/${size}.${format} ${String(width)}w`);
    }
    return parts.join(', ');
  };
  return { avif: build('avif'), webp: build('webp') };
}
