import { readFileSync } from 'node:fs';

import type { PERMISSIONS } from '@store/core/auth-permissions';
import {
  createProductSchema,
  productContentSchema,
  variantContentSchema,
} from '@store/core/admin-schemas';
import { describe, expect, it, vi } from 'vitest';

const seen = new Map<string, string>();
let current = '';

interface CapturedSpec {
  permission: string;
  op: (tx: never, input: never, session: never) => Promise<unknown>;
}
const lastSpec = new Map<string, CapturedSpec>();

vi.mock('@/lib/admin/catalog-action', () => ({
  catalogAction: (spec: CapturedSpec) => {
    seen.set(current, spec.permission);
    lastSpec.set(current, spec);
    return Promise.resolve({ ok: false, code: 'TEST' });
  },
}));

vi.mock('@/lib/media', () => ({ mediaConfig: () => Promise.resolve(null) }));

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
  updateProductImageAction: 'media.upload',
  deleteProductImageAction: 'media.upload',
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

describe('slugs: the admin accepts exactly what the public site routes', () => {
  const id = '0b8f7c64-5d1e-4c53-9d0a-1f7d3a6a9b21';
  const create = {
    sku: 'SKU-1',
    brand: 'b',
    categoryId: id,
    nameUk: 'x',
    nameEn: 'x',
    basePrice: '10.00',
  };
  it('refuses a slug that could redirect off-site or climb a path, in both schemas', () => {
    for (const slug of [
      'a//evil.example',
      'a/../b',
      '../x',
      '/a',
      'a b',
      'A-b',
      'a--',
      '-a',
      'a%2Fb',
      'a\u0000b',
      'a'.repeat(201),
      '',
    ]) {
      expect(productContentSchema.safeParse({ productId: id, slug }).success, slug).toBe(false);
      expect(createProductSchema.safeParse({ ...create, slug }).success, slug).toBe(false);
    }
    expect(
      productContentSchema.safeParse({ productId: id, slug: 'black-lace-bra-2' }).success,
    ).toBe(true);
  });

  it('refuses a NUL byte in any text field (Postgres would answer 22021)', () => {
    expect(productContentSchema.safeParse({ productId: id, nameUk: 'a\u0000b' }).success).toBe(
      false,
    );
    expect(
      productContentSchema.safeParse({ productId: id, descriptionUk: 'a\u0000b' }).success,
    ).toBe(false);
  });
});

describe('writing a cost needs catalog.cost.view as well as catalog.price', () => {
  it('the pricing action refuses a cost from a role that may not see it, and leaves the other fields alone', async () => {
    const spec = lastSpec.get('updateProductPricingAction');
    if (spec === undefined) throw new Error('the pricing action was not captured');
    // The role is checked before anything touches the transaction, so a stand-in is enough.
    const call = spec.op as (tx: unknown, input: unknown, session: unknown) => Promise<unknown>;
    await expect(
      call({}, { productId: 'p', costPrice: 100 }, { role: 'manager' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

/** The second table of docs/SECURITY.md (mutation -> permission -> where), parsed and compared with the code. */
describe('docs/SECURITY.md "Mutations" table matches the actions', () => {
  const doc = readFileSync(new URL('../../../../docs/SECURITY.md', import.meta.url), 'utf8');
  const section = /## Mutations: who may, where it is checked([\s\S]*?)\n## /.exec(doc)?.[1] ?? '';
  const documented = new Map<string, string>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const permission = /`([a-z]+\.[a-z.]+)`/.exec(cells[2] ?? '')?.[1];
    if (permission === undefined) continue;
    for (const match of (cells[3] ?? '').matchAll(/`(\w+Action)`/g)) {
      const name = match[1];
      if (name !== undefined) documented.set(name, permission);
    }
  }

  it('every documented action has the documented permission, and every catalog action is documented', () => {
    for (const [name, permission] of Object.entries(EXPECTED)) {
      expect(documented.get(name), name).toBe(permission);
    }
  });
});
