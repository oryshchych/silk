import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { CategoryDto } from '@store/shared/dto/catalog';

const getCachedCategories = vi.fn<() => Promise<CategoryDto[]>>();
vi.mock('./catalog', () => ({ getCachedCategories }));

const category: CategoryDto = {
  id: '0193f0a4-7c3e-7000-8000-000000000001',
  parentId: null,
  slug: 'bras',
  name: 'Bras',
  depth: 0,
  imageUrl: null,
};

let write: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  vi.resetModules();
  getCachedCategories.mockReset();
  write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadCategoryTree', () => {
  it('returns the tree and remembers it', async () => {
    const { loadCategoryTree } = await import('./navigation');
    getCachedCategories.mockResolvedValue([category]);
    expect((await loadCategoryTree('en')).map((c) => c.slug)).toEqual(['bras']);
  });

  it('serves the last good tree when the database fails, per locale', async () => {
    const { loadCategoryTree } = await import('./navigation');
    getCachedCategories.mockResolvedValueOnce([category]);
    await loadCategoryTree('en');
    getCachedCategories.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect((await loadCategoryTree('en')).map((c) => c.slug)).toEqual(['bras']);
  });

  it('rethrows on a cold start during an outage, so a cached page is never regenerated without navigation', async () => {
    const { loadCategoryTree } = await import('./navigation');
    getCachedCategories.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(loadCategoryTree('uk')).rejects.toThrow('ECONNREFUSED');
  });

  it('renders without navigation on request when the page is never cached (degrade)', async () => {
    const { loadCategoryTree } = await import('./navigation');
    getCachedCategories.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await loadCategoryTree('uk', { degrade: true })).toEqual([]);
  });

  it('logs one line with the error name and code, never query text or parameters', async () => {
    const { loadCategoryTree } = await import('./navigation');
    const driver = Object.assign(new Error('password authentication failed for user "u"'), {
      name: 'DatabaseError',
      code: '28P01',
    });
    const wrapped = new Error('Failed query: SELECT 1\nparams: secret-param', { cause: driver });
    getCachedCategories.mockRejectedValue(wrapped);
    await loadCategoryTree('uk', { degrade: true });
    const written = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written.trim().split('\n')).toHaveLength(1);
    expect(written).toContain('DatabaseError 28P01');
    expect(written).not.toMatch(/secret-param|SELECT|password/);
  });
});
