import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

const permissions: string[] = [];
let droppedOf: ((data: unknown) => unknown) | undefined;
vi.mock('./bound-action', () => ({
  adminAction: (spec: { permission: string }) => {
    permissions.push(spec.permission);
    return Promise.resolve({ ok: false, code: 'TEST' });
  },
}));
vi.mock('./catalog-action', () => ({
  catalogAction: (spec: { permission: string; dropped?: (data: unknown) => unknown }) => {
    permissions.push(spec.permission);
    droppedOf = spec.dropped;
    return Promise.resolve({ ok: false, code: 'TEST' });
  },
}));

const { commitImport, previewImport } = await import('./csv-import');

describe('import', () => {
  it('both require catalog.import (owner and admin only)', async () => {
    await previewImport('sku\n');
    await commitImport('sku\n');
    expect(permissions).toEqual(['catalog.import', 'catalog.import']);
  });

  it('the commit drops the redirect table and the slug set when it wrote anything, and nothing when it wrote nothing', () => {
    expect(droppedOf?.({ created: 2, updated: 0, failed: 0 })).toEqual({
      redirects: true,
      slugs: true,
    });
    expect(droppedOf?.({ created: 0, updated: 1, failed: 0 })).toEqual({
      redirects: true,
      slugs: true,
    });
    expect(droppedOf?.({ created: 0, updated: 0, failed: 3 })).toEqual({});
  });

  it('docs/SECURITY.md documents the route and both operations under catalog.import', () => {
    const doc = readFileSync(new URL('../../../../../docs/SECURITY.md', import.meta.url), 'utf8');
    const row =
      doc.split('\n').find((line) => line.includes('POST /admin/upload/products-csv')) ?? '';
    expect(row).toContain('`catalog.import`');
    expect(row).toContain('`previewImport`');
    expect(row).toContain('`commitImport`');
  });
});
