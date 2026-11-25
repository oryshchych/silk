import { describe, expect, it, vi } from 'vitest';

const permissions: string[] = [];
vi.mock('@/lib/admin/bound-action', () => ({
  adminAction: (spec: { permission: string }) => {
    permissions.push(spec.permission);
    return Promise.resolve({ ok: false, code: 'TEST' });
  },
}));
vi.mock('@/lib/admin/catalog-action', () => ({
  catalogAction: (spec: { permission: string }) => {
    permissions.push(spec.permission);
    return Promise.resolve({ ok: false, code: 'TEST' });
  },
}));

const { commitImportAction, previewImportAction } = await import('./admin-import');

describe('import actions', () => {
  it('both require catalog.import (owner and admin only)', async () => {
    await previewImportAction({});
    await commitImportAction({});
    expect(permissions).toEqual(['catalog.import', 'catalog.import']);
  });
});
