/**
 * Storefront reads on real Postgres (phase 1): categories, listing with
 * filters, product page, search. The catalog is the exactly known fixture in
 * `catalog-fixture.ts`; the Ukrainian dictionary, trigger and trigram index
 * come from the project image.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Db, type DbHandle } from '@store/db/client';
import { products } from '@store/db/schema';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import type { Reader } from '@store/db/types';

import {
  buildCategoryTree,
  defaultListingParams,
  getCategories,
  getCategoryPage,
  getFilterOptions,
  getProductBySlug,
  listProducts,
  PAGE_SIZE,
  parseListingParams,
  searchProducts,
} from '../src/catalog/index.ts';
import type { ListingParams } from '../src/catalog/listing-params.ts';
import { seedCatalogFixture, SECRET_COST, type CatalogFixture } from './catalog-fixture.ts';

let testDb: TestDatabase;
let handle: DbHandle;
let db: Db;
let fx: CatalogFixture;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
  db = handle.db;
  fx = await db.transaction(async (tx) => await seedCatalogFixture(tx));
});

afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

const params = (over: Partial<ListingParams> = {}): ListingParams => ({
  ...defaultListingParams,
  ...over,
});

async function slugs(over: Partial<ListingParams>, category = 'bras'): Promise<string[]> {
  const page = await getCategoryPage(db, category, 'uk');
  const listing = await listProducts(db, {
    categoryIds: page?.categoryIds ?? [],
    params: params(over),
    locale: 'uk',
  });
  return listing.items.map((item) => item.slug);
}

describe('categories', () => {
  it('lists active categories only and nests them in three levels', async () => {
    const flat = await getCategories(db, 'uk');
    expect(flat.map((c) => c.slug)).toEqual(['lingerie', 'homewear', 'bras', 'push-up']);
    const tree = buildCategoryTree(flat);
    expect(tree.map((n) => n.slug)).toEqual(['lingerie', 'homewear']);
    expect(tree[0]?.children[0]?.children[0]?.slug).toBe('push-up');
  });

  it('resolves a category page with breadcrumbs and descendants, in the requested locale', async () => {
    const uk = await getCategoryPage(db, 'push-up', 'uk');
    expect(uk?.page.breadcrumbs.map((c) => c.name)).toEqual(['Білизна', 'Бюстгальтери', 'Пуш-ап']);
    const en = await getCategoryPage(db, 'bras', 'en');
    expect(en?.page.name).toBe('Bras');
    expect(en?.categoryIds).toEqual([fx.categoryIds['bras'], fx.categoryIds['push-up']]);
  });

  it('does not resolve an inactive category or the child of one', async () => {
    expect(await getCategoryPage(db, 'archive', 'uk')).toBeNull();
    expect(await getCategoryPage(db, 'archive-old', 'uk')).toBeNull();
    expect(await getCategoryPage(db, 'missing', 'uk')).toBeNull();
  });
});

describe('listing', () => {
  it('includes subcategories and hides drafts, unpublished, future, gift cards and archived', async () => {
    expect(await slugs({})).toEqual(['aurora', 'lavanda', 'breeze']);
    expect(await slugs({}, 'push-up')).toEqual(['lavanda']);
  });

  it('applies three filters together from the URL', async () => {
    const parsed = parseListingParams({ band: '75', cup: 'B', color: 'black' });
    expect(await slugs(parsed)).toEqual(['aurora']);
  });

  it('matches band, cup and colour on ONE variant, not on three different ones', async () => {
    // lavanda has 75B in white and 75C in black, but no 75B in black.
    expect(await slugs({ bands: [75], cups: ['B'], colors: ['black'] })).not.toContain('lavanda');
    expect(await slugs({ bands: [75], cups: ['B'], colors: ['white'] })).toEqual([
      'aurora',
      'lavanda',
    ]);
  });

  it('in-stock needs unreserved stock on the same variant', async () => {
    // aurora 75B white has no stock; lavanda 75B white has.
    expect(await slugs({ bands: [75], colors: ['white'], inStock: true })).toEqual(['lavanda']);
    expect(await slugs({ inStock: true })).toEqual(['aurora', 'lavanda']);
  });

  it('filters by brand, price range and discount', async () => {
    expect(await slugs({ brands: ['Nord Lace'] })).toEqual(['breeze']);
    expect(await slugs({ priceMin: 90_000, priceMax: 130_000 })).toEqual(['aurora', 'lavanda']);
    expect(await slugs({ onSale: true })).toEqual(['aurora']);
  });

  it('filters apparel sizes in homewear', async () => {
    expect(await slugs({ sizes: ['M'] }, 'homewear')).toEqual(['robe']);
    expect(await slugs({ sizes: ['XL'] }, 'homewear')).toEqual([]);
  });

  it('sorts by price and by discount', async () => {
    expect(await slugs({ sort: 'price_asc' })).toEqual(['breeze', 'lavanda', 'aurora']);
    expect(await slugs({ sort: 'price_desc' })).toEqual(['aurora', 'lavanda', 'breeze']);
    expect((await slugs({ sort: 'discount' }))[0]).toBe('aurora');
  });

  it('reports stock per card and the main image with alt', async () => {
    const page = await getCategoryPage(db, 'bras', 'en');
    const listing = await listProducts(db, {
      categoryIds: page?.categoryIds ?? [],
      params: params(),
      locale: 'en',
    });
    const aurora = listing.items.find((i) => i.slug === 'aurora');
    const breeze = listing.items.find((i) => i.slug === 'breeze');
    expect(aurora).toMatchObject({ inStock: true, name: 'Bra "Aurora"' });
    expect(aurora?.image).toEqual({
      url: 'https://cdn.example/aurora-1.webp',
      alt: 'Aurora front',
      width: 800,
      height: 1000,
    });
    expect(breeze).toMatchObject({ inStock: false, image: null });
  });

  it('serves filter options only from the category products', async () => {
    const page = await getCategoryPage(db, 'bras', 'uk');
    const options = await getFilterOptions(db, {
      categoryIds: page?.categoryIds ?? [],
      locale: 'uk',
    });
    expect(options.bands).toEqual([70, 75, 80]);
    expect(options.cups).toEqual(['A', 'B', 'C']);
    expect(options.sizes).toEqual([]);
    expect(options.colors.map((c) => c.slug)).toEqual(['black', 'white', 'nude']);
    expect(options.brands).toEqual(['Aurelia', 'Nord Lace']);
    expect(options.price).toEqual({ min: 59_900, max: 129_900 });
  });
});

describe('listing pagination and query count', () => {
  let counted: { reader: Reader; count: () => number };

  beforeAll(async () => {
    // 30 more bras, so the category spans two pages.
    await db.execute(sql`
      INSERT INTO products (sku, slug, brand, category_id, name_uk, name_en, base_price, weight_grams,
                            is_active, published_at)
      SELECT 'BULK-' || n, 'bulk-' || n, 'Aurelia', ${fx.categoryIds['bras']}, 'Масовий ' || n, 'Bulk ' || n,
             50000 + n, 200, true, now() - make_interval(days => 10 + n)
        FROM generate_series(1, 30) AS n`);
    let calls = 0;
    counted = {
      reader: {
        select: db.select.bind(db),
        execute: (query) => {
          calls += 1;
          return db.execute(query);
        },
      },
      count: () => {
        const value = calls;
        calls = 0;
        return value;
      },
    };
  });

  it('paginates with a stable total', async () => {
    const page = await getCategoryPage(db, 'bras', 'uk');
    const input = { categoryIds: page?.categoryIds ?? [], locale: 'uk' as const };
    const first = await listProducts(db, { ...input, params: params() });
    const second = await listProducts(db, { ...input, params: params({ page: 2 }) });
    expect(first).toMatchObject({ total: 33, totalPages: 2, limit: PAGE_SIZE, page: 1 });
    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(second.items).toHaveLength(9);
    const ids = new Set([...first.items, ...second.items].map((i) => i.id));
    expect(ids.size).toBe(33);
  });

  it('keeps the total when the page is past the end', async () => {
    const page = await getCategoryPage(db, 'bras', 'uk');
    const beyond = await listProducts(db, {
      categoryIds: page?.categoryIds ?? [],
      params: params({ page: 50 }),
      locale: 'uk',
    });
    expect(beyond).toMatchObject({ items: [], total: 33, totalPages: 2, page: 50 });
  });

  it('runs a fixed number of queries whatever the page size (no N+1)', async () => {
    const bras = await getCategoryPage(db, 'bras', 'uk');
    const homewear = await getCategoryPage(db, 'homewear', 'uk');
    counted.count();
    await listProducts(counted.reader, {
      categoryIds: homewear?.categoryIds ?? [],
      params: params(),
      locale: 'uk',
    });
    const small = counted.count();
    await listProducts(counted.reader, {
      categoryIds: bras?.categoryIds ?? [],
      params: params(),
      locale: 'uk',
    });
    const full = counted.count();
    expect(small).toBeLessThanOrEqual(2);
    expect(full).toBe(small);
    expect(full).toBeLessThanOrEqual(2);
  });
});

describe('product page', () => {
  it('returns variants with availability flags and never stock counts', async () => {
    const product = await getProductBySlug(db, 'aurora', 'uk');
    expect(product?.name).toBe('Бюстгальтер «Аврора»');
    const flags = Object.fromEntries(
      (product?.variants ?? []).map((v) => [
        `${v.sizeLabel}:${v.colorSlug}`,
        [v.available, v.lastUnits],
      ]),
    );
    expect(flags).toEqual({
      '75B:black': [true, false],
      '80B:black': [true, true],
      '75B:white': [false, false],
    });
    expect(product?.colors.map((c) => c.slug)).toEqual(['black', 'white']);
    expect(product?.attributes).toEqual([
      { code: 'cup_type', name: 'Тип чашки', values: [{ slug: 'padded', value: 'З поролоном' }] },
    ]);
  });

  it('orders images by sort order, falls back to the product name for missing alt', async () => {
    const product = await getProductBySlug(db, 'aurora', 'en');
    expect(product?.images.map((i) => i.url)).toEqual([
      'https://cdn.example/aurora-1.webp',
      'https://cdn.example/aurora-2.webp',
      'https://cdn.example/aurora-black.webp',
    ]);
    expect(product?.images[1]?.alt).toBe('Bra "Aurora"');
    expect(product?.images[2]?.colorSlug).toBe('black');
    expect(product?.breadcrumbs.map((c) => c.slug)).toEqual(['lingerie', 'bras']);
  });

  it('exposes nothing internal in the serialized response', async () => {
    const product = await getProductBySlug(db, 'aurora', 'uk');
    const json = JSON.stringify(product);
    expect(json).not.toContain(String(SECRET_COST));
    expect(json).not.toMatch(
      /cost|stockQuantity|reservedQuantity|reserved|searchVector|search_vector|isActive/i,
    );
    const listing = await listProducts(db, {
      categoryIds: [fx.categoryIds['bras'] ?? ''],
      params: params(),
      locale: 'uk',
    });
    expect(JSON.stringify(listing)).not.toContain(String(SECRET_COST));
    expect(JSON.stringify(listing)).not.toMatch(/cost|stockQuantity|reserved/i);
  });

  it('is not found for drafts, unpublished, future, gift cards, archived and unknown slugs', async () => {
    for (const slug of ['draft', 'unpublished', 'future', 'giftcard', 'archived', 'nope']) {
      expect(await getProductBySlug(db, slug, 'uk')).toBeNull();
    }
  });
});

describe('search', () => {
  const find = async (query: string, locale: 'uk' | 'en' = 'uk'): Promise<string[]> =>
    (await searchProducts(db, { query, locale, page: 1 })).items.map((i) => i.slug);

  it('matches inflected forms through the Ukrainian dictionary', async () => {
    expect(await find('бюстгальтери')).toEqual(
      expect.arrayContaining(['aurora', 'lavanda', 'breeze']),
    );
    expect(await find('бюстгальтер')).not.toContain('robe');
  });

  it('stems -ий words (RR3: unaccent must not break й)', async () => {
    expect(await find('жіночий')).toContain('robe');
    expect(await find('жіночі')).toContain('robe');
  });

  it('finds a product despite a typo', async () => {
    expect(await find('бюстгалтер')).toEqual(expect.arrayContaining(['aurora', 'breeze']));
    expect(await find('aurra')).toContain('aurora');
  });

  it('searches the English name, brand and sku', async () => {
    expect(await find('lavender', 'en')).toEqual(['lavanda']);
    expect(await find('Nord Lace')).toContain('breeze');
    expect(await find('SKU-robe')).toContain('robe');
  });

  it('never returns hidden products', async () => {
    const all = await find('бюстгальтер');
    for (const hidden of ['draft', 'unpublished', 'future', 'giftcard', 'archived']) {
      expect(all).not.toContain(hidden);
    }
  });

  it('survives a negative, fractional or huge page number', async () => {
    for (const page of [-3, 0, 1.5, 10_000_000_000]) {
      const result = await searchProducts(db, { query: 'бюстгальтер', locale: 'uk', page });
      expect(result.page).toBeGreaterThanOrEqual(1);
    }
    const bras = await getCategoryPage(db, 'bras', 'uk');
    const listing = await listProducts(db, {
      categoryIds: bras?.categoryIds ?? [],
      params: params({ page: -1 }),
      locale: 'uk',
    });
    expect(listing.page).toBe(1);
  });

  it('returns nothing for short, unrelated or hostile input, without failing', async () => {
    expect(await find('a')).toEqual([]);
    expect(await find('   ')).toEqual([]);
    expect(await find('qzxwvk')).toEqual([]);
    expect(await find(`"'; DROP TABLE products; -- &|!():*`)).toEqual([]);
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(products);
    expect(row?.n ?? 0).toBeGreaterThan(0);
  });
});
