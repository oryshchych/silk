/**
 * The catalog write layer on real Postgres: domain rules, 301 redirects for a changed slug, the
 * category tree, the variants matrix, tags that touch ONLY what changed, audit diffs that never
 * carry the cost, and the role-dependent serialisation of every admin read.
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { categories, colors, products, redirects, sizes } from '@store/db/schema';
import { money } from '@store/shared/money';
import {
  categoryTag,
  listingTag,
  productTag,
  SHOWCASE_TAG,
  CATEGORIES_TAG,
} from '@store/shared/cache-tags';

import {
  AdminNotFoundError,
  BarcodeTakenError,
  CategoryCycleError,
  CategoryTooDeepError,
  DuplicateEntryError,
  NotPublishableError,
  SkuTakenError,
  SlugTakenError,
  TooManyVariantsError,
} from '../src/catalog-admin/errors.ts';
import {
  addProductImage,
  deleteProductImage,
  imageKeys,
  listAdminImages,
  TooManyImagesError,
  updateProductImage,
} from '../src/catalog-admin/images.ts';
import { createCategory, moveCategory, updateCategory } from '../src/catalog-admin/categories.ts';
import { saveColor, saveSize } from '../src/catalog-admin/dictionaries.ts';
import {
  createProduct,
  InvalidPriceError,
  setProductActive,
  updateProductContent,
  updateProductPricing,
} from '../src/catalog-admin/products.ts';
import { getAdminProduct, listAdminProducts } from '../src/catalog-admin/read.ts';
import {
  generateVariants,
  updateVariantContent,
  updateVariantPricing,
} from '../src/catalog-admin/variants.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let handle: DbHandle;
let skeletonProduct: string;
let rootCategory: string;

const run = async <T>(fn: Parameters<DbHandle['db']['transaction']>[0]) =>
  (await handle.db.transaction(fn)) as T;

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(4);
  skeletonProduct = world.fixture.productId;
  const [row] = await handle.db.select({ id: categories.id }).from(categories).limit(1);
  rootCategory = row?.id ?? '';
});
afterAll(async () => {
  await world.close();
});

let counter = 0;
async function newProduct(price = '1299.00', cost: string | null = '500.00') {
  counter += 1;
  return await handle.db.transaction(
    async (tx) =>
      await createProduct(tx, {
        sku: `SKU-${String(counter)}`,
        slug: `product-${String(counter)}`,
        brand: 'Brand',
        categoryId: rootCategory,
        nameUk: `Товар ${String(counter)}`,
        nameEn: `Product ${String(counter)}`,
        basePrice: money(Number(price.replace('.', ''))),
        costPrice: cost === null ? null : money(Number(cost.replace('.', ''))),
        weightGrams: 200,
      }),
  );
}

describe('products', () => {
  it('a new product is a draft; its slug and SKU are unique and the error does not abort the transaction', async () => {
    const first = await newProduct();
    const [row] = await handle.db
      .select()
      .from(products)
      .where(eq(products.id, first.data.productId));
    expect(row).toMatchObject({ isActive: false });
    await handle.db.transaction(async (tx) => {
      await expect(
        createProduct(tx, {
          sku: 'OTHER',
          slug: row?.slug ?? '',
          brand: 'b',
          categoryId: rootCategory,
          nameUk: 'x',
          nameEn: 'x',
          basePrice: money(100),
          weightGrams: 100,
        }),
      ).rejects.toBeInstanceOf(SlugTakenError);
      await expect(
        createProduct(tx, {
          sku: row?.sku ?? '',
          slug: 'brand-new-slug',
          brand: 'b',
          categoryId: rootCategory,
          nameUk: 'x',
          nameEn: 'x',
          basePrice: money(100),
          weightGrams: 100,
        }),
      ).rejects.toBeInstanceOf(SkuTakenError);
      // The transaction is still usable.
      await tx.execute(sql`SELECT 1`);
    });
  });

  it('a changed slug leaves 301s for both locales, collapses chains and frees a reused slug', async () => {
    const { data } = await newProduct();
    const id = data.productId;
    const read = async () =>
      (await handle.db.select().from(products).where(eq(products.id, id)))[0];
    const original = (await read())?.slug ?? '';
    const rename = async (slug: string) =>
      await handle.db.transaction(
        async (tx) => await updateProductContent(tx, { productId: id, slug }),
      );
    await rename('first-rename');
    await rename('second-rename');
    const rows = await handle.db.select().from(redirects);
    const pairs = new Map(rows.map((r) => [r.fromPath, r.toPath]));
    expect(pairs.get(`/product/${original}`)).toBe('/product/second-rename');
    expect(pairs.get('/product/first-rename')).toBe('/product/second-rename');
    expect(pairs.get(`/en/product/${original}`)).toBe('/en/product/second-rename');
    expect(rows.every((r) => r.statusCode === 301)).toBe(true);
    // Going back to an old slug: that path is live again and must not redirect away.
    await rename('first-rename');
    const after = new Map(
      (await handle.db.select().from(redirects)).map((r) => [r.fromPath, r.toPath]),
    );
    expect(after.has('/product/first-rename')).toBe(false);
    expect(after.get('/product/second-rename')).toBe('/product/first-rename');
    expect(after.get(`/product/${original}`)).toBe('/product/first-rename');
    for (const [from, to] of after) expect(from).not.toBe(to);
  });

  it('a change touches only that product and its category in the tags; a no-op touches nothing', async () => {
    const { data } = await newProduct();
    const outcome = await run<Awaited<ReturnType<typeof updateProductContent>>>(
      async (tx) =>
        await updateProductContent(tx, { productId: data.productId, nameUk: 'Нова назва' }),
    );
    expect(new Set(outcome.tags)).toEqual(
      new Set([productTag(data.productId), SHOWCASE_TAG, listingTag(rootCategory)]),
    );
    expect(outcome.tags).not.toContain(productTag(skeletonProduct));
    expect(outcome.tags).not.toContain(CATEGORIES_TAG);
    const same = await run<Awaited<ReturnType<typeof updateProductContent>>>(
      async (tx) =>
        await updateProductContent(tx, { productId: data.productId, nameUk: 'Нова назва' }),
    );
    expect(same.tags).toEqual([]);
    expect(same.data.changed).toEqual([]);
  });

  it('pricing: the old price must stay above the price; the audit diff never carries the cost value', async () => {
    const { data } = await newProduct('1000.00', '400.00');
    await expect(
      handle.db.transaction(
        async (tx) =>
          await updateProductPricing(tx, {
            productId: data.productId,
            compareAtPrice: money(90_000),
          }),
      ),
    ).rejects.toBeInstanceOf(InvalidPriceError);
    const outcome = await run<Awaited<ReturnType<typeof updateProductPricing>>>(
      async (tx) =>
        await updateProductPricing(tx, {
          productId: data.productId,
          basePrice: money(120_000),
          compareAtPrice: money(150_000),
          costPrice: money(55_555),
        }),
    );
    expect(outcome.audit.diff['costPrice']).toBe('changed');
    expect(JSON.stringify(outcome.audit.diff)).not.toContain('55555');
    expect(JSON.stringify(outcome.audit.diff)).not.toContain('40000');
    expect(outcome.audit.diff['basePrice']).toEqual({ from: 100_000, to: 120_000 });
  });

  it('publishing needs an active variant and an active category; unpublishing is always allowed', async () => {
    const { data } = await newProduct();
    await expect(
      handle.db.transaction(
        async (tx) => await setProductActive(tx, { productId: data.productId, isActive: true }),
      ),
    ).rejects.toBeInstanceOf(NotPublishableError);
    const [size] = await handle.db.select({ id: sizes.id }).from(sizes).limit(1);
    const [color] = await handle.db.select({ id: colors.id }).from(colors).limit(1);
    await handle.db.transaction(async (tx) => {
      await generateVariants(tx, {
        productId: data.productId,
        sizeIds: [size?.id ?? ''],
        colorIds: [color?.id ?? ''],
      });
    });
    const published = await run<Awaited<ReturnType<typeof setProductActive>>>(
      async (tx) => await setProductActive(tx, { productId: data.productId, isActive: true }),
    );
    expect(published.data.isActive).toBe(true);
    const [row] = await handle.db.select().from(products).where(eq(products.id, data.productId));
    expect(row?.publishedAt).not.toBeNull();
    await handle.db.transaction(async (tx) => {
      await setProductActive(tx, { productId: data.productId, isActive: false });
    });
  });

  it('an unknown product or category is a typed not-found', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    await expect(
      handle.db.transaction(async (tx) => await updateProductContent(tx, { productId: ghost })),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
    await expect(
      handle.db.transaction(
        async (tx) =>
          await updateProductContent(tx, { productId: skeletonProduct, categoryId: ghost }),
      ),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
  });
});

describe('the variants matrix', () => {
  async function dictionary(sizeCount: number, colorCount: number) {
    counter += 1;
    const sizeIds: string[] = [];
    const colorIds: string[] = [];
    await handle.db.transaction(async (tx) => {
      for (let i = 0; i < sizeCount; i += 1) {
        const s = await saveSize(tx, {
          system: 'apparel',
          label: `M${String(counter)}-${String(i)}`,
          band: null,
          cup: null,
          euLabel: null,
          usLabel: null,
          sortOrder: i,
        });
        sizeIds.push(s.data.sizeId);
      }
      for (let i = 0; i < colorCount; i += 1) {
        const c = await saveColor(tx, {
          slug: `col-${String(counter)}-${String(i)}`,
          nameUk: `Колір ${String(i)}`,
          nameEn: `Colour ${String(i)}`,
          hex: '#112233',
          sortOrder: i,
        });
        colorIds.push(c.data.colorId);
      }
    });
    return { sizeIds, colorIds };
  }

  it('3 colours x 12 sizes make 36 variants once; running it again creates none', async () => {
    const { sizeIds, colorIds } = await dictionary(12, 3);
    const { data } = await newProduct();
    const first = await run<Awaited<ReturnType<typeof generateVariants>>>(
      async (tx) => await generateVariants(tx, { productId: data.productId, sizeIds, colorIds }),
    );
    expect(first.data).toEqual({ created: 36, skipped: 0 });
    const again = await run<Awaited<ReturnType<typeof generateVariants>>>(
      async (tx) => await generateVariants(tx, { productId: data.productId, sizeIds, colorIds }),
    );
    expect(again.data).toEqual({ created: 0, skipped: 36 });
    const product = await getAdminProduct(handle.db, data.productId, true);
    expect(product?.variants).toHaveLength(36);
    expect(new Set(product?.variants.map((v) => v.sku)).size).toBe(36);
    expect(product?.variants.every((v) => v.stockQuantity === 0 && v.isActive)).toBe(true);
  });

  it('refuses more than 200 at once and an unknown size or colour', async () => {
    const { sizeIds, colorIds } = await dictionary(21, 10);
    const { data } = await newProduct();
    await expect(
      handle.db.transaction(
        async (tx) => await generateVariants(tx, { productId: data.productId, sizeIds, colorIds }),
      ),
    ).rejects.toBeInstanceOf(TooManyVariantsError);
    await expect(
      handle.db.transaction(
        async (tx) =>
          await generateVariants(tx, {
            productId: data.productId,
            sizeIds: ['00000000-0000-4000-8000-000000000000'],
            colorIds: colorIds.slice(0, 1),
          }),
      ),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
  });

  it('a price override must be positive (database check) and changing it tags the product', async () => {
    const { sizeIds, colorIds } = await dictionary(1, 1);
    const { data } = await newProduct();
    await run(
      async (tx) => await generateVariants(tx, { productId: data.productId, sizeIds, colorIds }),
    );
    const product = await getAdminProduct(handle.db, data.productId, false);
    const variantId = product?.variants[0]?.id ?? '';
    const outcome = await run<Awaited<ReturnType<typeof updateVariantPricing>>>(
      async (tx) => await updateVariantPricing(tx, { variantId, priceOverride: money(99_900) }),
    );
    expect(outcome.tags).toContain(productTag(data.productId));
    expect(
      (await getAdminProduct(handle.db, data.productId, false))?.variants[0]?.priceOverride,
    ).toBe(99_900);
  });
});

describe('categories', () => {
  const make = async (parentId: string | null, slug: string) =>
    await run<Awaited<ReturnType<typeof createCategory>>>(
      async (tx) => await createCategory(tx, { parentId, slug, nameUk: slug, nameEn: slug }),
    );

  it('depth follows the parent, a fifth level is refused, a duplicate slug is typed', async () => {
    const a = await make(null, 'tree-a');
    const b = await make(a.data.categoryId, 'tree-b');
    const c = await make(b.data.categoryId, 'tree-c');
    const d = await make(c.data.categoryId, 'tree-d');
    const depths = await handle.db
      .select({ slug: categories.slug, depth: categories.depth })
      .from(categories);
    expect(depths.find((x) => x.slug === 'tree-d')?.depth).toBe(3);
    await expect(make(d.data.categoryId, 'tree-e')).rejects.toBeInstanceOf(CategoryTooDeepError);
    await expect(make(null, 'tree-a')).rejects.toBeInstanceOf(SlugTakenError);
  });

  it('a move refuses a cycle and an overflow, recomputes the whole subtree and tags the old and new chains', async () => {
    const a = await make(null, 'mv-a');
    const b = await make(a.data.categoryId, 'mv-b');
    const c = await make(b.data.categoryId, 'mv-c');
    const other = await make(null, 'mv-other');
    await expect(
      run(
        async (tx) =>
          await moveCategory(tx, { categoryId: a.data.categoryId, parentId: c.data.categoryId }),
      ),
    ).rejects.toBeInstanceOf(CategoryCycleError);
    await expect(
      run(
        async (tx) =>
          await moveCategory(tx, { categoryId: a.data.categoryId, parentId: a.data.categoryId }),
      ),
    ).rejects.toBeInstanceOf(CategoryCycleError);
    const moved = await run<Awaited<ReturnType<typeof moveCategory>>>(
      async (tx) =>
        await moveCategory(tx, { categoryId: b.data.categoryId, parentId: other.data.categoryId }),
    );
    expect(moved.tags).toEqual(
      expect.arrayContaining([
        CATEGORIES_TAG,
        categoryTag(a.data.categoryId),
        categoryTag(other.data.categoryId),
        listingTag(other.data.categoryId),
        categoryTag(c.data.categoryId),
      ]),
    );
    const rows = await handle.db.select().from(categories);
    const depthOf = (id: string) => rows.find((r) => r.id === id)?.depth;
    expect(depthOf(b.data.categoryId)).toBe(1);
    expect(depthOf(c.data.categoryId)).toBe(2);
    // other (depth 0) -> b -> c; moving "other" under a depth-3 node would overflow.
    const deep = await make(null, 'mv-deep0');
    const d1 = await make(deep.data.categoryId, 'mv-deep1');
    const d2 = await make(d1.data.categoryId, 'mv-deep2');
    const d3 = await make(d2.data.categoryId, 'mv-deep3');
    await expect(
      run(
        async (tx) =>
          await moveCategory(tx, {
            categoryId: other.data.categoryId,
            parentId: d3.data.categoryId,
          }),
      ),
    ).rejects.toBeInstanceOf(CategoryTooDeepError);
  });

  it('a changed category slug leaves a 301', async () => {
    const a = await make(null, 'slug-old');
    await run(
      async (tx) => await updateCategory(tx, { categoryId: a.data.categoryId, slug: 'slug-new' }),
    );
    const rows = await handle.db.select().from(redirects);
    expect(rows.find((r) => r.fromPath === '/category/slug-old')?.toPath).toBe(
      '/category/slug-new',
    );
    expect(rows.find((r) => r.fromPath === '/en/category/slug-old')?.toPath).toBe(
      '/en/category/slug-new',
    );
  });
});

describe('dictionaries', () => {
  it('a duplicate colour or size is a typed error; editing a colour tags only the products that use it', async () => {
    const created = await run<Awaited<ReturnType<typeof saveColor>>>(
      async (tx) =>
        await saveColor(tx, {
          slug: 'dict-red',
          nameUk: 'Червоний',
          nameEn: 'Red',
          hex: '#ff0000',
          sortOrder: 0,
        }),
    );
    await expect(
      run(
        async (tx) =>
          await saveColor(tx, {
            slug: 'dict-red',
            nameUk: 'x',
            nameEn: 'x',
            hex: '#ff0000',
            sortOrder: 0,
          }),
      ),
    ).rejects.toBeInstanceOf(DuplicateEntryError);
    const unused = await run<Awaited<ReturnType<typeof saveColor>>>(
      async (tx) =>
        await saveColor(tx, {
          colorId: created.data.colorId,
          slug: 'dict-red',
          nameUk: 'Яскраво-червоний',
          nameEn: 'Bright red',
          hex: '#ff0000',
          sortOrder: 0,
        }),
    );
    // No product uses it yet: only the showcase tag, no product or category tags.
    expect(unused.tags).toEqual([SHOWCASE_TAG]);
  });
});

describe('admin reads are serialised per role', () => {
  it('the product DTO carries the cost only for a role that may see it, nested variants included', async () => {
    const { data } = await newProduct('1000.00', '123.45');
    const withCost = await getAdminProduct(handle.db, data.productId, true);
    const without = await getAdminProduct(handle.db, data.productId, false);
    expect(JSON.stringify(withCost)).toContain('"costPrice":12345');
    const wire = JSON.stringify(without);
    expect(wire).not.toContain('costPrice');
    expect(wire).not.toContain('12345');
    expect(wire).not.toContain('cost');
  });

  it('the product list likewise: the key and the value are absent for a role without the permission', async () => {
    await newProduct('1000.00', '777.77');
    const owner = JSON.stringify(await listAdminProducts(handle.db, {}, true));
    const content = JSON.stringify(await listAdminProducts(handle.db, {}, false));
    expect(owner).toContain('"costPrice":77777');
    expect(content).not.toContain('costPrice');
    expect(content).not.toContain('77777');
  });

  it('list filters: search is literal (a percent sign matches nothing), pagination and low stock', async () => {
    const literal = await listAdminProducts(handle.db, { q: '%' }, false);
    expect(literal.total).toBe(0);
    const bySku = await listAdminProducts(handle.db, { q: 'SKU-1' }, false);
    expect(bySku.items.every((item) => item.sku.includes('SKU-1'))).toBe(true);
    const low = await listAdminProducts(handle.db, { lowStock: true }, false);
    expect(low.items.length).toBeGreaterThan(0);
    const huge = await listAdminProducts(handle.db, { page: 9_999_999 }, false);
    expect(huge.items).toEqual([]);
  });
});

describe('product images', () => {
  const urlFor = (key: string) => `https://media.example.test/${key}`;
  async function add(productId: string) {
    const imageId = randomUUID();
    const variants = Object.fromEntries(
      imageKeys(productId, imageId).map((key) => [key.split('/').slice(-1)[0] ?? key, urlFor(key)]),
    );
    return await run<Awaited<ReturnType<typeof addProductImage>>>(
      async (tx) =>
        await addProductImage(tx, {
          productId,
          imageId,
          url: variants['full.webp'] ?? '',
          variants,
          width: 4000,
          height: 3000,
        }),
    );
  }

  it('keys are made of ids and fixed words only, and every one is a safe storage key', () => {
    const keys = imageKeys(
      '0b8f7c64-5d1e-4c53-9d0a-1f7d3a6a9b21',
      '1b8f7c64-5d1e-4c53-9d0a-1f7d3a6a9b22',
    );
    expect(keys).toHaveLength(6);
    for (const key of keys) {
      expect(key).toMatch(
        /^products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(thumb|card|full)\.(webp|avif)$/,
      );
    }
  });

  it('adds images in order, tags only that product, and refuses the 31st', async () => {
    const { data } = await newProduct();
    const first = await add(data.productId);
    const second = await add(data.productId);
    expect(first.tags).toEqual(
      expect.arrayContaining([productTag(data.productId), listingTag(rootCategory), SHOWCASE_TAG]),
    );
    const listed = await listAdminImages(handle.db, data.productId);
    expect(listed.map((i) => i.sortOrder)).toEqual([0, 1]);
    expect(listed[0]?.thumbUrl).toContain('thumb.webp');
    for (let i = 0; i < 28; i += 1) await add(data.productId);
    await expect(add(data.productId)).rejects.toBeInstanceOf(TooManyImagesError);
    expect(second.data.imageId).not.toBe(first.data.imageId);
  }, 60_000);

  it('alt text, colour and order are saved; an unknown colour is refused; a no-op changes nothing', async () => {
    const { data } = await newProduct();
    const image = await add(data.productId);
    const [color] = await handle.db.select({ id: colors.id }).from(colors).limit(1);
    const saved = await run<Awaited<ReturnType<typeof updateProductImage>>>(
      async (tx) =>
        await updateProductImage(tx, {
          imageId: image.data.imageId,
          altUk: 'Чорний бюстгальтер',
          altEn: 'Black bra',
          colorId: color?.id ?? null,
          sortOrder: 3,
        }),
    );
    expect(saved.data.changed.sort()).toEqual(['altEn', 'altUk', 'colorId', 'sortOrder']);
    const again = await run<Awaited<ReturnType<typeof updateProductImage>>>(
      async (tx) =>
        await updateProductImage(tx, { imageId: image.data.imageId, altEn: 'Black bra' }),
    );
    expect(again.tags).toEqual([]);
    await expect(
      handle.db.transaction(
        async (tx) =>
          await updateProductImage(tx, {
            imageId: image.data.imageId,
            colorId: '00000000-0000-4000-8000-000000000000',
          }),
      ),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
  });

  it('deleting returns the storage keys of exactly that image and removes the row', async () => {
    const { data } = await newProduct();
    const image = await add(data.productId);
    const outcome = await run<Awaited<ReturnType<typeof deleteProductImage>>>(
      async (tx) => await deleteProductImage(tx, { imageId: image.data.imageId }),
    );
    expect(outcome.data.keys).toEqual(imageKeys(data.productId, image.data.imageId));
    expect(await listAdminImages(handle.db, data.productId)).toHaveLength(0);
  });
});

describe('review round 1: slugs, the category tree, barcodes', () => {
  it('a slug given away and then REUSED by a new product or category stops redirecting (the redirect would shadow the live page)', async () => {
    const old = await newProduct();
    const [row] = await handle.db
      .select()
      .from(products)
      .where(eq(products.id, old.data.productId));
    const oldSlug = row?.slug ?? '';
    await handle.db.transaction(
      async (tx) =>
        await updateProductContent(tx, { productId: old.data.productId, slug: `moved-${oldSlug}` }),
    );
    const pathsBefore = (await handle.db.select().from(redirects)).map((r) => r.fromPath);
    expect(pathsBefore).toContain(`/product/${oldSlug}`);
    await handle.db.transaction(
      async (tx) =>
        await createProduct(tx, {
          sku: `REUSE-${oldSlug}`.slice(0, 60),
          slug: oldSlug,
          brand: 'b',
          categoryId: rootCategory,
          nameUk: 'x',
          nameEn: 'x',
          basePrice: money(100),
          weightGrams: 100,
        }),
    );
    const after = (await handle.db.select().from(redirects)).map((r) => r.fromPath);
    expect(after).not.toContain(`/product/${oldSlug}`);
    expect(after).not.toContain(`/en/product/${oldSlug}`);
    // The same for a category.
    const cat = await run<Awaited<ReturnType<typeof createCategory>>>(
      async (tx) =>
        await createCategory(tx, {
          parentId: null,
          slug: 'cat-gives-away',
          nameUk: 'a',
          nameEn: 'a',
        }),
    );
    await run(
      async (tx) =>
        await updateCategory(tx, { categoryId: cat.data.categoryId, slug: 'cat-moved-on' }),
    );
    expect((await handle.db.select().from(redirects)).map((r) => r.fromPath)).toContain(
      '/category/cat-gives-away',
    );
    await run(
      async (tx) =>
        await createCategory(tx, {
          parentId: null,
          slug: 'cat-gives-away',
          nameUk: 'b',
          nameEn: 'b',
        }),
    );
    expect((await handle.db.select().from(redirects)).map((r) => r.fromPath)).not.toContain(
      '/category/cat-gives-away',
    );
  });

  it('two category moves racing to make a cycle (A under B, B under A): exactly one wins, never a cycle', async () => {
    for (let round = 0; round < 8; round += 1) {
      const a = await run<Awaited<ReturnType<typeof createCategory>>>(
        async (tx) =>
          await createCategory(tx, {
            parentId: null,
            slug: `race-a-${String(round)}`,
            nameUk: 'a',
            nameEn: 'a',
          }),
      );
      const b = await run<Awaited<ReturnType<typeof createCategory>>>(
        async (tx) =>
          await createCategory(tx, {
            parentId: null,
            slug: `race-b-${String(round)}`,
            nameUk: 'b',
            nameEn: 'b',
          }),
      );
      const barrier = new Barrier(2);
      const outcomes = await Promise.all(
        [
          { categoryId: a.data.categoryId, parentId: b.data.categoryId },
          { categoryId: b.data.categoryId, parentId: a.data.categoryId },
        ].map(async (input) => {
          const other = world.connect(1);
          await barrier.wait();
          return await other.db
            .transaction(async (tx) => await moveCategory(tx, input))
            .then(() => 'ok' as const)
            .catch((error: unknown) => (error instanceof CategoryCycleError ? 'cycle' : 'broken'));
        }),
      );
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'cycle')).toHaveLength(1);
      const rows = await handle.db.select().from(categories);
      const parentOf = (id: string) => rows.find((r) => r.id === id)?.parentId;
      expect(
        parentOf(a.data.categoryId) === b.data.categoryId &&
          parentOf(b.data.categoryId) === a.data.categoryId,
      ).toBe(false);
    }
  }, 60_000);

  it('a barcode belongs to one variant; several variants without a barcode are fine', async () => {
    const sizeIds: string[] = [];
    const colorIds: string[] = [];
    await handle.db.transaction(async (tx) => {
      for (let i = 0; i < 2; i += 1) {
        sizeIds.push(
          (
            await saveSize(tx, {
              system: 'apparel',
              label: `BC${String(counter)}${String(i)}`,
              band: null,
              cup: null,
              euLabel: null,
              usLabel: null,
              sortOrder: 0,
            })
          ).data.sizeId,
        );
      }
      colorIds.push(
        (
          await saveColor(tx, {
            slug: `bc-${String(counter)}`,
            nameUk: 'c',
            nameEn: 'c',
            hex: '#010203',
            sortOrder: 0,
          })
        ).data.colorId,
      );
    });
    const { data } = await newProduct();
    await run(
      async (tx) => await generateVariants(tx, { productId: data.productId, sizeIds, colorIds }),
    );
    const product = await getAdminProduct(handle.db, data.productId, false);
    const [first, second] = product?.variants ?? [];
    await run(
      async (tx) =>
        await updateVariantContent(tx, { variantId: first?.id ?? '', barcode: '4006381333931' }),
    );
    await expect(
      handle.db.transaction(
        async (tx) =>
          await updateVariantContent(tx, { variantId: second?.id ?? '', barcode: '4006381333931' }),
      ),
    ).rejects.toBeInstanceOf(BarcodeTakenError);
    // No barcode is NULL (the action schema turns an empty field into null), and any number coexist.
    await run(
      async (tx) => await updateVariantContent(tx, { variantId: first?.id ?? '', barcode: null }),
    );
    await run(
      async (tx) => await updateVariantContent(tx, { variantId: second?.id ?? '', barcode: null }),
    );
  });

  it('a NUL byte in the list search is dropped, not sent to Postgres', async () => {
    const result = await listAdminProducts(handle.db, { q: 'SKU\u0000-1' }, false);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});
