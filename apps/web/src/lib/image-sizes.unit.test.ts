import { describe, expect, it } from 'vitest';

import { CATEGORY_CARD_SIZES, GALLERY_SIZES, LISTING_CARD_SIZES } from './image-sizes';

/** The width in CSS pixels a `sizes` attribute resolves to at a viewport width (min-width queries only). */
function resolve(sizes: string, viewport: number): number {
  for (const part of sizes.split(',').map((p) => p.trim())) {
    const query = /^\(min-width:\s*(\d+)px\)\s+(.+)$/.exec(part);
    const [, min, value] = query ?? [];
    if (query !== null && Number(min) > viewport) continue;
    const text = value ?? part;
    return text.endsWith('vw')
      ? (Number(text.slice(0, -2)) / 100) * viewport
      : Number(text.slice(0, -2));
  }
  throw new Error('no sizes entry');
}

const PAGE = 1152; // max-w-6xl
const PAD = 32;
const GAP = 16;
const inner = (viewport: number): number => Math.min(viewport, PAGE) - PAD;

/** The real laid-out width of a card, from the grids in the page components. */
const grid = {
  /** Home showcases and search: two columns, four from lg, no sidebar. */
  listing: (v: number): number => (v >= 1024 ? (inner(v) - 3 * GAP) / 4 : (inner(v) - GAP) / 2),
  /** Category: a 16 rem column and a 2 rem gap from md; two columns, three from lg. */
  category: (v: number): number => {
    const main = v >= 768 ? inner(v) - 256 - 32 : inner(v);
    return v >= 1024 ? (main - 2 * GAP) / 3 : (main - GAP) / 2;
  },
  /** Product gallery: a two column page from md. */
  gallery: (v: number): number => (v >= 768 ? (inner(v) - 32) / 2 : inner(v)),
};

const VIEWPORTS = [
  320, 375, 414, 600, 767, 768, 900, 1023, 1024, 1100, 1151, 1152, 1280, 1600, 1920,
];

describe.each([
  ['listing (home showcases, search)', LISTING_CARD_SIZES, grid.listing],
  ['category', CATEGORY_CARD_SIZES, grid.category],
  ['gallery', GALLERY_SIZES, grid.gallery],
] as const)('sizes for %s', (_name, sizes, real) => {
  it('is never smaller than the laid-out width, and never more than 1.45x larger, at every viewport', () => {
    for (const viewport of VIEWPORTS) {
      const chosen = resolve(sizes, viewport);
      const actual = real(viewport);
      expect(
        chosen,
        `${String(viewport)}px: ${String(chosen)} < ${String(actual)}`,
      ).toBeGreaterThanOrEqual(actual - 1);
      expect(
        chosen,
        `${String(viewport)}px: ${String(chosen)} too large for ${String(actual)}`,
      ).toBeLessThanOrEqual(actual * 1.45);
    }
  });
});
