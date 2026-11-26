/**
 * The rendition geometry, in one sharp-free module so the storefront (which must not import
 * `sharp`) and the converter share the same numbers and cannot drift.
 */
export const WIDTHS = { thumb: 320, card: 800, full: 1600 } as const;
export type RenditionSize = keyof typeof WIDTHS;

/**
 * Width of the master the renditions are cut from: the source fitted inside
 * `WIDTHS.full` x `WIDTHS.full` without enlargement (how `process-image.ts` makes it). A portrait
 * photo is therefore narrower than `WIDTHS.full`.
 */
export function masterWidth(width: number, height: number): number {
  const scale = Math.min(1, WIDTHS.full / Math.max(width, height));
  return Math.max(1, Math.round(width * scale));
}

/** The real width of a rendition of a `width` x `height` source: `min(target, master width)`. */
export const renditionWidth = (size: RenditionSize, width: number, height: number): number =>
  Math.min(WIDTHS[size], masterWidth(width, height));
