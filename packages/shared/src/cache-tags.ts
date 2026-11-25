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
