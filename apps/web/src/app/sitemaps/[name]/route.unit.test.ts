import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDb = vi.fn(() => Promise.reject(new Error('the database must not be touched')));
const sitemapFileStarts = vi.fn(() => Promise.resolve(['a-first', 'm-second']));
const listSitemapProducts = vi.fn(() => Promise.resolve([]));
const listSitemapCategories = vi.fn(() => Promise.resolve([]));

vi.mock('../../../lib/db', () => ({ getDb: () => getDb() }));
vi.mock('../../../lib/site-url', () => ({
  getSiteUrl: () => Promise.resolve('https://s.example'),
}));
vi.mock('@store/core/sitemap', () => ({
  sitemapFileStarts: () => sitemapFileStarts(),
  listSitemapProducts: () => listSitemapProducts(),
  listSitemapCategories: () => listSitemapCategories(),
}));
vi.mock('@store/core/legal-read', () => ({
  listLegalForSitemap: () => Promise.resolve([]),
}));

const { GET } = await import('./route');
const call = (name: string): Promise<Response> =>
  GET(new Request('https://s.example/x'), { params: Promise.resolve({ name }) });

beforeEach(() => {
  getDb.mockClear();
  sitemapFileStarts.mockClear();
});

describe('GET /sitemaps/[name]', () => {
  it('answers a malformed name with a 404 and makes ZERO database calls', async () => {
    for (const name of [
      'x.xml',
      'PAGES.xml',
      'products-01.xml',
      'products-1234567.xml',
      '',
      'a'.repeat(5000),
    ]) {
      expect((await call(name)).status, name).toBe(404);
    }
    expect(getDb).not.toHaveBeenCalled();
    expect(sitemapFileStarts).not.toHaveBeenCalled();
  });

  it('a flood of bad names does not take the slots real fetches need', async () => {
    getDb.mockImplementation(() => Promise.resolve({}) as never);
    const flood = await Promise.all(
      Array.from({ length: 200 }, (_, i) => call(`bad-${String(i)}.xml`)),
    );
    expect(flood.every((r) => r.status === 404)).toBe(true);
    // A real file right after the flood is served, not refused with a 503.
    const real = await call('pages.xml');
    expect(real.status).toBe(200);
    expect(await real.text()).toContain('<urlset');
  });

  it('answers a well-formed name past the end of the split with a 404', async () => {
    getDb.mockImplementation(() => Promise.resolve({}) as never);
    expect((await call('products-9.xml')).status).toBe(404);
  });

  it('computes the file split once for the index and the files (no count per request)', async () => {
    getDb.mockImplementation(() => Promise.resolve({}) as never);
    await call('pages.xml');
    await call('products-1.xml');
    await call('products-0.xml');
    expect(sitemapFileStarts.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
