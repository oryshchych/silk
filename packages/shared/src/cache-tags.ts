/**
 * Cache tags of the public catalog (ADR-8). The storefront tags its cached
 * reads with them; whatever changes a product or category invalidates the
 * same strings (`revalidateTag(tag, 'max')` in apps/web, reached from the
 * worker through the outbox). One definition, so the two sides cannot drift.
 */
export const CATEGORIES_TAG = 'categories';

export const productTag = (id: string): string => `product:${id}`;
export const categoryTag = (id: string): string => `category:${id}`;

/**
 * The cached LISTING of a category (and its filter options). Separate from `categoryTag`, which a
 * product page also carries for its breadcrumb: a product edit refreshes the listings that show
 * it (this tag) without touching the product pages of its siblings.
 */
export const listingTag = (id: string): string => `listing:${id}`;

/** The home page showcases (newest, bestsellers): any product change refreshes them. */
export const SHOWCASE_TAG = 'showcase';

/**
 * Legal pages (ADR-8). `legal:{kind}` is read by that page; `legal-nav` by everything that lists the
 * published pages (the footer on every storefront page, the sitemap). Publishing a version drops both.
 */
export const LEGAL_NAV_TAG = 'legal-nav';
export const legalTag = (kind: string): string => `legal:${kind}`;

/**
 * The home-page banners. The read is cached for everybody alike (the display period is decided by the database
 * clock when the cache is filled, and a short TTL moves it across a period boundary); any banner change in the admin
 * drops it after the commit.
 */
export const BANNERS_TAG = 'banners';
