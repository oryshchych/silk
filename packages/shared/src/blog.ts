/**
 * The blog's public addresses and shapes, shared by the admin, the storefront, the proxy gate and the sitemap so they
 * cannot drift: a post lives at `/blog/<slug>`, a tag page at `/blog/tag/<tag>`, both words lower-case words joined by
 * hyphens (the database refuses anything else).
 */
export const BLOG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BLOG_SLUG_MAX = 120;
export const BLOG_TAG_MAX = 40;
export const BLOG_MAX_TAGS = 10;
export const BLOG_PAGE_SIZE = 12;
export const BLOG_MAX_PAGE = 200;

export const isBlogSlug = (value: string): boolean =>
  value.length <= BLOG_SLUG_MAX && BLOG_SLUG.test(value);
export const isBlogTag = (value: string): boolean =>
  value.length <= BLOG_TAG_MAX && BLOG_SLUG.test(value);

export const BLOG_PATH = '/blog';
export const blogPostPath = (slug: string): string => `${BLOG_PATH}/${slug}`;
export const blogTagPath = (tag: string): string => `${BLOG_PATH}/tag/${tag}`;
