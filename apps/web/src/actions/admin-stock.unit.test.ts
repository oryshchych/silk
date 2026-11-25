import { describe, expect, it, vi } from 'vitest';

const seen: string[] = [];
vi.mock('@/lib/admin/catalog-action', () => ({
  catalogAction: (spec: { permission: string }) => {
    seen.push(spec.permission);
    return Promise.resolve({ ok: false, code: 'TEST' });
  },
}));

const { adjustStockAction } = await import('./admin-stock');

describe('adjustStockAction', () => {
  it('requires stock.adjust (owner, admin and manager; never content)', async () => {
    await adjustStockAction({});
    expect(seen).toEqual(['stock.adjust']);
  });
});
