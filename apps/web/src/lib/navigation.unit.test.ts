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
    getCachedCategories.mockRejectedValue(new Error('connect ECONNREFUSED\nsecond line'));
    expect((await loadCategoryTree('en')).map((c) => c.slug)).toEqual(['bras']);
    expect(await loadCategoryTree('uk')).toEqual([]);
  });

  it('renders an empty navigation on a cold start during an outage, and logs one line', async () => {
    const { loadCategoryTree } = await import('./navigation');
    getCachedCategories.mockRejectedValue(new Error('connect ECONNREFUSED\npassword=secret'));
    expect(await loadCategoryTree('uk')).toEqual([]);
    const written = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('ECONNREFUSED');
    expect(written).not.toContain('secret');
  });
});
