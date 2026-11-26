/**
 * The content bounds of the catalogue: ONE source for the readiness report, the CSV template, the
 * import preview and the content guide (`docs/CONTENT_GUIDE.md`). They are editorial guidance, not
 * database limits (the columns allow more: see `schema.ts` and `catalog-admin/schemas.ts`); a value
 * outside a bound is reported by `pnpm content:check`, never refused by the editor.
 *
 * Lengths are characters after trimming. A text the storefront stores as rich text (category SEO
 * text) is measured on its visible text, without tags.
 */
/**
 * The storefront appends ` | <site name>` to every title (the shop name is a placeholder, Q1: "LACE & SILK",
 * 11 characters, plus the 3 of the separator). A search result shows about 60 characters, so the meta
 * title itself may use the rest. A test in `apps/web` fails when the site name outgrows this reserve.
 */
export const TITLE_SUFFIX_RESERVE = 14;
export const TITLE_DISPLAY_MAX = 60;

export const CONTENT_BOUNDS = {
  metaTitle: { min: 20, max: TITLE_DISPLAY_MAX - TITLE_SUFFIX_RESERVE },
  metaDescription: { min: 70, max: 160 },
  shortDescription: { min: 20, max: 300 },
  description: { min: 80, max: 5_000 },
  composition: { min: 3, max: 500 },
  care: { min: 3, max: 500 },
  name: { min: 3, max: 120 },
  alt: { min: 5, max: 125 },
  /** Category text under the product list. */
  seoText: { min: 200, max: 5_000 },
} as const;

export type ContentField = keyof typeof CONTENT_BOUNDS;

/** The product feed drops a variant whose SKU is longer (Google's `id` limit; `apps/web/src/lib/product-feed.ts`). */
export const FEED_MAX_ID_LENGTH = 50;

/** Photo bounds, measured on the stored source dimensions (`product_images.width` and `height`). */
export const PHOTO_BOUNDS = {
  /** Narrower than this and the 1600 px rendition is an enlargement. */
  minWidth: 1_000,
  /** width / height: from 2:3 portrait to a square. */
  aspectMin: 2 / 3,
  aspectMax: 1,
  /** The upload route's own hard limits (`packages/media`), repeated here for the guide. */
  maxBytes: 12 * 1024 * 1024,
  maxSide: 12_000,
  maxPixels: 40_000_000,
} as const;

/** Wording a reviewer must source before it is published (certifications, medical or absolute claims). */
export const CLAIM_PATTERN =
  '[Oo]eko-?[Tt]ex|GOTS|[Cc]ertif|[Сс]ертифік|[Гг]іпоалерг|[Hh]ypoallerg|[Аа]нтибактер|[Aa]ntibacter|[Cc]linically|[Кк]лінічно|[Лл]ікувальн';
