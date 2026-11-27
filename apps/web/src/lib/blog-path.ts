import { isBlogSlug, isBlogTag } from '@store/shared/blog';

export type BlogPath =
  | { kind: 'post'; locale: 'uk' | 'en'; slug: string }
  | { kind: 'tag'; locale: 'uk' | 'en'; tag: string };

/**
 * `/blog/<slug>`, `/blog/tag/<tag>` and the `/en` forms; the word is whatever the client sent (still encoded). Null for
 * the index `/blog` and for every other path. A word of the wrong shape comes back as a path with a word that is not a slug:
 * the proxy answers it with the shared 404 without touching the database.
 */
export function parseBlogPath(pathname: string): BlogPath | null {
  const tag = /^\/(en\/)?blog\/tag\/([^/]+)$/.exec(pathname);
  if (tag?.[2] !== undefined) {
    return { kind: 'tag', locale: tag[1] === undefined ? 'uk' : 'en', tag: tag[2] };
  }
  const post = /^\/(en\/)?blog\/([^/]+)$/.exec(pathname);
  if (post?.[2] !== undefined && post[2] !== 'tag') {
    return { kind: 'post', locale: post[1] === undefined ? 'uk' : 'en', slug: post[2] };
  }
  return null;
}

/** The gate key of a path, or null when the word cannot exist (wrong shape). */
export function blogGateKey(path: BlogPath): string | null {
  if (path.kind === 'post') return isBlogSlug(path.slug) ? `${path.locale}:${path.slug}` : null;
  return isBlogTag(path.tag) ? `${path.locale}:tag:${path.tag}` : null;
}
