/**
 * Turns an uploaded photo into the renditions the shop serves: WebP and AVIF at three widths.
 *
 * Everything that makes an upload dangerous is bounded HERE, before any pixel is decoded:
 *  - the type comes from the bytes (`sniffImage`), never from the name or the declared type;
 *  - a decompression bomb is refused by libvips itself (`limitInputPixels`) and by the declared
 *    dimensions, before the image is decoded;
 *  - animated or multi-page files are refused;
 *  - output carries no metadata (EXIF, GPS, ICC comments are stripped), is auto-oriented, and is
 *    never enlarged.
 */
import sharp, { type Metadata } from 'sharp';

import { sniffImage } from './sniff.ts';
import { WIDTHS, type RenditionSize } from './widths.ts';

export const LIMITS = {
  /** Upload size cap in bytes (enforced while the body streams, and again here). */
  maxBytes: 12 * 1024 * 1024,
  /** Pixels in the source (width x height): libvips refuses a bigger image before decoding. */
  maxPixels: 40_000_000,
  /** Longest side of the source. */
  maxSide: 12_000,
} as const;

export { WIDTHS };
export type { RenditionSize };
export type RenditionFormat = 'webp' | 'avif';

export interface Rendition {
  size: RenditionSize;
  format: RenditionFormat;
  width: number;
  height: number;
  body: Buffer;
}

export interface ProcessedImage {
  /** Dimensions of the oriented source. */
  width: number;
  height: number;
  renditions: Rendition[];
}

export class ImageRejectedError extends Error {
  readonly reason: 'unsupported_type' | 'too_large' | 'too_many_pixels' | 'animated' | 'unreadable';

  constructor(reason: ImageRejectedError['reason']) {
    super(`image rejected: ${reason}`);
    this.name = 'ImageRejectedError';
    this.reason = reason;
  }
}

// Bound libvips' own appetite: one worker thread per operation, no operation cache.
sharp.concurrency(1);
sharp.cache(false);

const QUALITY = { webp: 78, avif: 52 } as const;

export async function processImage(bytes: Buffer): Promise<ProcessedImage> {
  if (bytes.length > LIMITS.maxBytes) throw new ImageRejectedError('too_large');
  if (sniffImage(bytes) === null) throw new ImageRejectedError('unsupported_type');

  // The header is read WITHOUT libvips' pixel limit, so an oversized image is named as such
  // (`too_many_pixels`) by our own check below instead of surfacing as an unreadable file; only
  // the DECODE, further down, runs under the limit. Reading dimensions decodes no pixels.
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    throw new ImageRejectedError('unreadable');
  }
  const source = sharp(bytes, {
    limitInputPixels: LIMITS.maxPixels,
    failOn: 'error',
    sequentialRead: true,
  });
  if ((meta.pages ?? 1) > 1) throw new ImageRejectedError('animated');
  const width = meta.width;
  const height = meta.height;
  if (width < 1 || height < 1) throw new ImageRejectedError('unreadable');
  if (Math.max(width, height) > LIMITS.maxSide || width * height > LIMITS.maxPixels) {
    throw new ImageRejectedError('too_many_pixels');
  }

  const oriented = (meta.orientation ?? 1) >= 5;
  const sourceWidth = oriented ? height : width;
  const sourceHeight = oriented ? width : height;
  const renditions: Rendition[] = [];
  try {
    // The source is DECODED ONCE, straight down to the largest rendition (a JPEG is shrunk while
    // it loads, so a 30 MP photo never exists in full), oriented, as a raw master of at most
    // 1600 x 1600 pixels (10 MB). Every rendition is then made from that small master: the
    // peak memory of one conversion is the master plus one encoder, not six decodes of the source.
    const { data: master, info: masterInfo } = await source
      .rotate()
      .resize({ width: WIDTHS.full, height: WIDTHS.full, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = {
      width: masterInfo.width,
      height: masterInfo.height,
      channels: masterInfo.channels,
    };
    for (const size of ['full', 'card', 'thumb'] as const) {
      const target = Math.min(WIDTHS[size], masterInfo.width);
      for (const format of ['webp', 'avif'] as const) {
        const pipeline = sharp(master, { raw }).resize({ width: target, withoutEnlargement: true });
        const { data, info } = await (
          format === 'webp'
            ? pipeline.webp({ quality: QUALITY.webp, effort: 4 })
            : pipeline.avif({ quality: QUALITY.avif, effort: 3 })
        ).toBuffer({ resolveWithObject: true });
        renditions.push({ size, format, width: info.width, height: info.height, body: data });
      }
    }
  } catch (error) {
    if (error instanceof ImageRejectedError) throw error;
    throw new ImageRejectedError('unreadable');
  }
  return { width: sourceWidth, height: sourceHeight, renditions };
}
