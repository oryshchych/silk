/**
 * The `sizes` attribute of each photo place: the width the image is laid out at, per viewport,
 * derived from the page grids (container `max-w-6xl` = 1152 px with 16 px padding; 16 px column
 * gap). A value is never smaller than the real width (a blurry photo) and a little larger where a
 * range has a spread (the browser takes the nearest `w`). `image-sizes.unit.test.ts` checks each
 * against its grid.
 */

/** The product page gallery's main photo: half the page from `md` (at most 544 px: the page stops growing at 1152), else full width. */
export const GALLERY_SIZES = '(min-width: 1152px) 544px, (min-width: 768px) 50vw, 100vw';

/** Home showcases and search: two columns, four from `lg`, no sidebar. */
export const LISTING_CARD_SIZES = '(min-width: 1152px) 268px, (min-width: 1024px) 24vw, 48vw';

/** A category page: a 16 rem filter column from `md`; two columns, three from `lg`. */
export const CATEGORY_CARD_SIZES =
  '(min-width: 1152px) 267px, (min-width: 1024px) 24vw, (min-width: 768px) 34vw, 48vw';
