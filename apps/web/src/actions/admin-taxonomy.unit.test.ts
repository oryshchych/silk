import type { PERMISSIONS } from '@store/core/auth-permissions';
import { describe, expect, it, vi } from 'vitest';

const seen = new Map<string, string>();
let current = '';

vi.mock('@/lib/admin/catalog-action', () => ({
  catalogAction: (spec: { permission: string }) => {
    seen.set(current, spec.permission);
    return Promise.resolve({ ok: false, code: 'TEST' });
  },
}));

const actions = await import('./admin-taxonomy');

/** What `docs/SECURITY.md` says each taxonomy action requires. */
const EXPECTED: Record<string, keyof typeof PERMISSIONS> = {
  createCategoryAction: 'categories.edit',
  updateCategoryAction: 'categories.edit',
  updateCategoryContentAction: 'categories.edit',
  moveCategoryAction: 'categories.edit',
  saveColorAction: 'dictionaries.edit',
  saveSizeAction: 'dictionaries.edit',
  saveAttributeAction: 'dictionaries.edit',
  saveAttributeValueAction: 'dictionaries.edit',
  setProductAttributesAction: 'catalog.edit',
};

describe('taxonomy actions name the permission that docs/SECURITY.md lists', () => {
  it('every exported action is in the table, with exactly that permission', async () => {
    const names = Object.keys(actions).sort();
    expect(names).toEqual(Object.keys(EXPECTED).sort());
    for (const name of names) {
      current = name;
      await (actions as Record<string, (input: unknown) => Promise<unknown>>)[name]?.({});
    }
    expect(Object.fromEntries(seen)).toEqual(EXPECTED);
  });
});
