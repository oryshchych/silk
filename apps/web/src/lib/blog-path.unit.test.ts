import { describe, expect, it } from 'vitest';

import { blogGateKey, parseBlogPath } from './blog-path';

describe('parseBlogPath', () => {
  it('reads a post, a tag and the locale', () => {
    expect(parseBlogPath('/blog/how-to')).toEqual({ kind: 'post', locale: 'uk', slug: 'how-to' });
    expect(parseBlogPath('/en/blog/how-to')).toEqual({
      kind: 'post',
      locale: 'en',
      slug: 'how-to',
    });
    expect(parseBlogPath('/blog/tag/bras')).toEqual({ kind: 'tag', locale: 'uk', tag: 'bras' });
    expect(parseBlogPath('/en/blog/tag/bras')).toEqual({ kind: 'tag', locale: 'en', tag: 'bras' });
  });

  it('is null for the index, deeper paths and other pages (the proxy leaves those alone)', () => {
    for (const path of [
      '/blog',
      '/en/blog',
      '/blog/',
      '/blog/a/b',
      '/blog/tag',
      '/product/x',
      '/',
    ]) {
      expect(parseBlogPath(path), path).toBeNull();
    }
  });
});

describe('blogGateKey', () => {
  it('a word of the wrong shape has no key (it never reaches the database)', () => {
    const post = (slug: string) => blogGateKey({ kind: 'post', locale: 'uk', slug });
    expect(post('good-slug')).toBe('uk:good-slug');
    for (const slug of ['Bad', 'a b', '%2e%2e', 'a'.repeat(121), 'a--b'])
      expect(post(slug), slug).toBeNull();
    expect(blogGateKey({ kind: 'tag', locale: 'en', tag: 'bras' })).toBe('en:tag:bras');
    expect(blogGateKey({ kind: 'tag', locale: 'en', tag: 'UPPER' })).toBeNull();
  });
});
