import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ keys: [] as string[], total: 5, tagsUk: ['a'], tagsEn: ['a'] }));

vi.mock('next/cache', () => ({
  unstable_cache:
    <T>(fn: () => Promise<T>, key: string[]) =>
    async (): Promise<T> => {
      state.keys.push(key.join('|'));
      return await fn();
    },
}));
vi.mock('./db', () => ({ getDb: () => Promise.resolve({}) }));
vi.mock('@store/core/blog', () => ({
  countPublishedPosts: () =>
    Promise.resolve({ total: state.total, totalPages: Math.max(1, Math.ceil(state.total / 12)) }),
  listPublishedPosts: (_db: unknown, _locale: string, o: { page: number }) =>
    Promise.resolve({ items: [], page: o.page, total: state.total, totalPages: 1 }),
  getPublishedPost: () => Promise.resolve(null),
  listPublishedTags: (_db: unknown, locale: string) =>
    Promise.resolve(
      (locale === 'uk' ? state.tagsUk : state.tagsEn).map((tag) => ({ tag, count: 1 })),
    ),
}));

const { loadBlogPage, tagInBothLanguages } = await import('./blog');

beforeEach(() => {
  state.keys = [];
  state.total = 5;
  state.tagsUk = ['a'];
  state.tagsEn = ['a'];
});

describe('loadBlogPage: a page number a client chose never becomes a key unless the page exists', () => {
  it('a sweep of 260 pages on a one-page blog builds one page key (plus one count key per call), and 259 are missing', async () => {
    const results = [];
    for (let page = 1; page <= 260; page += 1)
      results.push(await loadBlogPage('uk', undefined, page));
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'missing')).toHaveLength(259);
    const pageKeys = new Set(state.keys.filter((key) => key.startsWith('blog-list|')));
    expect([...pageKeys]).toEqual(['blog-list|uk||1']);
    expect(new Set(state.keys.filter((key) => key.startsWith('blog-count|'))).size).toBe(1);
  });

  it('page 4 of 3 is missing, page 3 exists, and page 1 of an empty list is an honest page', async () => {
    state.total = 30;
    expect((await loadBlogPage('uk', 'bras', 3)).status).toBe('ok');
    expect((await loadBlogPage('uk', 'bras', 4)).status).toBe('missing');
    state.total = 0;
    expect((await loadBlogPage('en', undefined, 1)).status).toBe('ok');
    expect((await loadBlogPage('en', undefined, 2)).status).toBe('missing');
  });
});

describe('tagInBothLanguages', () => {
  it('is true only when the tag is in use in both languages', async () => {
    expect(await tagInBothLanguages('a')).toBe(true);
    state.tagsEn = [];
    expect(await tagInBothLanguages('a')).toBe(false);
    state.tagsUk = [];
    state.tagsEn = ['a'];
    expect(await tagInBothLanguages('a')).toBe(false);
  });
});
