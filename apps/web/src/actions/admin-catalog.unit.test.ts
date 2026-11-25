import type { PERMISSIONS } from '@store/core/auth-permissions';
import { productContentSchema, variantContentSchema } from '@store/core/admin-schemas';
import { describe, expect, it, vi } from 'vitest';

const seen = new Map<string, string>();
let current = '';

vi.mock('@/lib/admin/catalog-action', () => ({
  catalogAction: (spec: { permission: string }) => {
    seen.set(current, spec.permission);
    return Promise.resolve({ ok: false, code: 'TEST' });
  },
}));

const actions = await import('./admin-catalog');

/** What `docs/SECURITY.md` says each catalog action requires. */
const EXPECTED: Record<string, keyof typeof PERMISSIONS> = {
  createProductAction: 'catalog.create',
  updateProductContentAction: 'catalog.edit',
  updateProductPricingAction: 'catalog.price',
  setProductActiveAction: 'catalog.publish',
  generateVariantsAction: 'catalog.edit',
  updateVariantContentAction: 'catalog.edit',
  updateVariantPricingAction: 'catalog.price',
};

describe('catalog actions name the permission that docs/SECURITY.md lists', () => {
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

describe('the allowlist of what a text-editing action can change', () => {
  it('has no price key, so a role with catalog.edit cannot reach a price through it', () => {
    const forbidden = ['basePrice', 'compareAtPrice', 'costPrice', 'priceOverride'];
    for (const key of Object.keys(productContentSchema.shape)) expect(forbidden).not.toContain(key);
    for (const key of Object.keys(variantContentSchema.shape)) expect(forbidden).not.toContain(key);
  });

  it('drops unknown keys instead of passing them on (no mass assignment)', () => {
    const parsed = productContentSchema.parse({
      productId: '0b8f7c64-5d1e-4c53-9d0a-1f7d3a6a9b21',
      nameUk: 'x',
      basePrice: '1.00',
      isActive: true,
      costPrice: '1.00',
    });
    expect(Object.keys(parsed).sort()).toEqual(['nameUk', 'productId']);
  });
});
