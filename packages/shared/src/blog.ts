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

/** The address `tag` is the tag index (`/blog/tag`): a post with it would shadow it. */
export const RESERVED_BLOG_SLUGS: readonly string[] = ['tag'];

/**
 * The serialised size of the text a post form sends. The whole action body travels in ONE request that the proxy caps at
 * 64 KB (`proxyClientMaxBodySize`), and a larger one is a failure with no message; the form counts this and refuses to
 * submit above `POST_FORM_MAX_BYTES` (a margin under the cap for the other fields and the framing), and the schema refuses
 * the same measure on the server. Both languages' bodies share it: about 28 000 Cyrillic characters in total.
 */
export const POST_FORM_MAX_BYTES = 60_000;

export function postPayloadBytes(fields: Readonly<Record<string, unknown>>): number {
  return new TextEncoder().encode(JSON.stringify(fields)).length;
}

const ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" } as const;

/**
 * A plain description from the first paragraph of the SANITISED body html, for a post that has neither an excerpt nor a
 * meta description: tags dropped, the basic entities decoded, whitespace collapsed, cut at a word near `max` characters
 * with an ellipsis. Null when the body has no paragraph text.
 */
export function descriptionFromHtml(html: string, max = 155): string | null {
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1];
  if (paragraph === undefined) return null;
  const text = paragraph
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITY[entity as keyof typeof ENTITY])
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}
