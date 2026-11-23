/**
 * Cache tags of the public catalog (ADR-8). The storefront tags its cached
 * reads with them; whatever changes a product or category invalidates the
 * same strings (`revalidateTag(tag, 'max')` in apps/web, reached from the
 * worker through the outbox). One definition, so the two sides cannot drift.
 */
export const CATEGORIES_TAG = 'categories';

export const productTag = (id: string): string => `product:${id}`;
export const categoryTag = (id: string): string => `category:${id}`;

/** The home page showcases (newest, bestsellers): any product change refreshes them. */
export const SHOWCASE_TAG = 'showcase';
