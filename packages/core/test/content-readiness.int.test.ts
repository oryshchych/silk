/**
 * The content readiness report on real Postgres: every failure class is one overridden field of an
 * otherwise complete product; the report agrees with the storefront's own visibility rule; the
 * checker only reads; a 5 000 product catalogue costs a constant number of queries.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { productImages, products } from '@store/db/schema';
import { CONTENT_BOUNDS, FEED_MAX_ID_LENGTH } from '@store/shared/content-bounds';
import type { ContentReadinessDto } from '@store/shared/dto/content-readiness';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';
import { createDb } from '@store/db/client';

import { safeMediaUrl } from '../src/catalog/media-url.ts';
import { visibleProduct } from '../src/catalog/sql.ts';
import { readContentReadiness, URL_SAFE_PATTERN } from '../src/content-readiness/read.ts';
import { addProduct, filler, seedDictionaries } from './content-fixture.ts';

let testDb: TestDatabase;
let handle: DbHandle;
let report: ContentReadinessDto;

const codes = (sku: string): string[] => {
  const row = report.products.find((entry) => entry.sku === `SKU-${sku}`);
  if (row === undefined) throw new Error(`no row for ${sku}`);
  return row.findings
    .filter((finding) => finding.severity === 'blocker')
    .map((finding) =>
      [finding.code, finding.field, finding.locale].filter((part) => part !== null).join(':'),
    );
};
const row = (sku: string) => {
  const found = report.products.find((entry) => entry.sku === `SKU-${sku}`);
  if (found === undefined) throw new Error(`no row for ${sku}`);
  return found;
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  await handle.db.transaction(async (tx) => {
    const dict = await seedDictionaries(tx);
    const c = dict.categoryId;
    await addProduct(tx, dict, { key: 'good', categoryId: c });
    await addProduct(tx, dict, {
      key: 'draft',
      categoryId: c,
      product: { isActive: false, publishedAt: null },
    });
    await addProduct(tx, dict, {
      key: 'unpublished',
      categoryId: c,
      product: { publishedAt: null },
    });
    await addProduct(tx, dict, {
      key: 'future',
      categoryId: c,
      product: { publishedAt: new Date(Date.now() + 2 * 86_400_000) },
    });
    await addProduct(tx, dict, { key: 'hiddencat', categoryId: dict.hiddenCategoryId });
    await addProduct(tx, dict, { key: 'altuk', categoryId: c, images: [{ altEn: null }] });
    await addProduct(tx, dict, {
      key: 'altblank',
      categoryId: c,
      images: [{ altUk: '   ', altEn: '' }],
    });
    await addProduct(tx, dict, {
      key: 'longmeta',
      categoryId: c,
      product: { metaDescriptionUk: filler('x', CONTENT_BOUNDS.metaDescription.max + 1) },
    });
    await addProduct(tx, dict, {
      key: 'shortmeta',
      categoryId: c,
      product: { metaTitleEn: 'Too short' },
    });
    await addProduct(tx, dict, {
      key: 'nometa',
      categoryId: c,
      product: { metaDescriptionEn: null },
    });
    await addProduct(tx, dict, {
      key: 'norend',
      categoryId: c,
      images: [{ without: 'card.avif' }],
    });
    await addProduct(tx, dict, { key: 'nophoto', categoryId: c, images: [] });
    await addProduct(tx, dict, { key: 'novariant', categoryId: c, stock: null });
    await addProduct(tx, dict, { key: 'nostock', categoryId: c, stock: 0 });
    await addProduct(tx, dict, { key: 'inactivevariant', categoryId: c, variantActive: false });
    await addProduct(tx, dict, {
      key: 'narrow',
      categoryId: c,
      images: [{ width: 600, height: 900 }],
    });
    await addProduct(tx, dict, {
      key: 'wide',
      categoryId: c,
      images: [{ width: 2000, height: 1000 }],
    });
    await addProduct(tx, dict, {
      key: 'badurl',
      categoryId: c,
      images: [{ url: 'javascript:alert(1)' }],
    });
    await addProduct(tx, dict, { key: 'nogtin', categoryId: c, barcode: null });
    await addProduct(tx, dict, { key: 'badslug', categoryId: c, product: { slug: 'Bad_Slug' } });
    await addProduct(tx, dict, { key: 'nobrand', categoryId: c, product: { brand: '  ' } });
    await addProduct(tx, dict, {
      key: 'copied',
      categoryId: c,
      product: {
        descriptionEn: filler('опис copied', 200),
        descriptionUk: filler('опис copied', 200),
      },
    });
    await addProduct(tx, dict, {
      key: 'claim',
      categoryId: c,
      product: { descriptionEn: filler('Oeko-Tex certified cotton', 200) },
    });
    await addProduct(tx, dict, {
      key: 'dup1',
      categoryId: c,
      product: { metaTitleUk: filler('Same title', 45) },
    });
    await addProduct(tx, dict, {
      key: 'dup2',
      categoryId: c,
      product: { metaTitleUk: filler('Same title', 45) },
    });
    const ZW = '\u200b';
    await addProduct(tx, dict, {
      key: 'zerowidth',
      categoryId: c,
      images: [{ altUk: `${ZW.repeat(6)}.`, altEn: ZW }],
      product: {
        metaTitleUk: ZW.repeat(25),
        metaDescriptionUk: ZW.repeat(80),
        shortDescriptionEn: '\u00a0',
        descriptionUk: 'x',
      },
    });
    await addProduct(tx, dict, { key: 'noindex', categoryId: c, product: { noindex: true } });
    await addProduct(tx, dict, { key: 'longsku', categoryId: c, variantSku: 'S'.repeat(51) });
    await addProduct(tx, dict, {
      key: 'copymeta',
      categoryId: c,
      product: {
        metaDescriptionEn: filler('Опис для пошуку copymeta', 120),
        metaDescriptionUk: filler('Опис для пошуку copymeta', 120),
      },
    });
    await addProduct(tx, dict, {
      key: 'gift',
      categoryId: c,
      product: { kind: 'gift_card', weightGrams: 0 },
    });
    return dict;
  });
  report = await readContentReadiness(handle.db);
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

describe('state: only the storefront-visible products are live', () => {
  it('the good product is live and ready', () => {
    expect(row('good')).toMatchObject({ live: true, ready: true, isActive: true });
  });
  it('a draft is not live, not a blocker for the gate, and carries an informational finding', () => {
    expect(row('draft')).toMatchObject({ live: false, isActive: false, ready: true });
    expect(row('draft').findings.map((f) => f.code)).toContain('inactive');
  });
  it('an active product without a publish date, or published in the future, is not live and blocks', () => {
    for (const key of ['unpublished', 'future']) {
      expect(row(key).live).toBe(false);
      expect(codes(key)).toContain('unpublished');
    }
  });
  it('an active product in an inactive category is not live and blocks', () => {
    expect(row('hiddencat').live).toBe(false);
    expect(codes('hiddencat')).toContain('category_hidden');
  });
  it('gift cards are not part of the catalogue report', () => {
    expect(report.products.find((entry) => entry.sku === 'SKU-gift')).toBeUndefined();
  });
  it('the live set equals the storefront rule', async () => {
    const result = await handle.db.execute(
      sql`SELECT p.sku FROM products p WHERE ${visibleProduct} ORDER BY p.sku`,
    );
    const storefront = result.rows.map((r) => String(r['sku']));
    expect(
      report.products
        .filter((p) => p.live)
        .map((p) => p.sku)
        .sort(),
    ).toEqual(storefront);
  });
});

describe('failure classes', () => {
  it('alt in one language only', () => {
    expect(codes('altuk')).toEqual(['photo_alt_missing:alt:en']);
    expect(codes('altblank')).toEqual(['photo_alt_missing:alt:uk', 'photo_alt_missing:alt:en']);
  });
  it('a meta description over the bound, a meta title under it, a missing meta', () => {
    expect(codes('longmeta')).toEqual(['too_long:meta_description:uk']);
    expect(codes('shortmeta')).toEqual(['too_short:meta_title:en']);
    expect(codes('nometa')).toEqual(['missing:meta_description:en']);
  });
  it('an image row without a rendition', () => {
    expect(codes('norend')).toEqual(['photo_renditions_missing']);
  });
  it('no photo, no variant, no stock, an inactive-only variant', () => {
    expect(codes('nophoto')).toEqual(['no_photo']);
    expect(codes('novariant')).toEqual(['no_active_variant']);
    expect(codes('nostock')).toEqual(['no_stock']);
    expect(codes('inactivevariant')).toEqual(['no_active_variant']);
  });
  it('photo size and shape are advice, not blockers', () => {
    expect(codes('narrow')).toEqual([]);
    expect(codes('wide')).toEqual([]);
    expect(row('narrow').findings.map((f) => f.code)).toContain('photo_too_narrow');
    expect(row('wide').findings.map((f) => f.code)).toContain('photo_aspect');
  });
  it('an unsafe image URL, an unservable slug and a blank brand block', () => {
    expect(codes('badurl')).toContain('photo_url_unsafe');
    expect(codes('badslug')).toEqual(['slug_unservable']);
    expect(codes('nobrand')).toEqual(['brand_missing']);
  });
  it('a missing GTIN, a copied text, a claim word and a shared meta title are warnings', () => {
    expect(codes('nogtin')).toEqual([]);
    const has = (key: string, code: string): boolean =>
      row(key).findings.some((f) => f.code === code && f.severity === 'warning');
    expect(has('nogtin', 'gtin_missing')).toBe(true);
    expect(has('copied', 'same_in_both_languages')).toBe(true);
    expect(has('claim', 'claim_review')).toBe(true);
    expect(has('dup1', 'duplicate_in_catalog')).toBe(true);
    expect(has('dup2', 'duplicate_in_catalog')).toBe(true);
    expect(has('good', 'duplicate_in_catalog')).toBe(false);
  });
  it('the Cyrillic claim wording is found too', async () => {
    await handle.db.execute(
      sql`UPDATE products SET description_uk = 'Гіпоалергенна тканина ' || description_uk WHERE sku = 'SKU-good'`,
    );
    const again = await readContentReadiness(handle.db);
    expect(
      again.products
        .find((p) => p.sku === 'SKU-good')
        ?.findings.some((f) => f.code === 'claim_review'),
    ).toBe(true);
    await handle.db.execute(
      sql`UPDATE products SET description_uk = replace(description_uk, 'Гіпоалергенна тканина ', '') WHERE sku = 'SKU-good'`,
    );
  });
});

describe('junk content does not pass for content', () => {
  it('zero-width and blank-only text is missing, a placeholder alt is a blocker', () => {
    const found = codes('zerowidth');
    expect(found).toContain('missing:meta_title:uk');
    expect(found).toContain('missing:meta_description:uk');
    expect(found).toContain('missing:short_description:en');
    expect(found).toContain('photo_alt_too_short:alt');
    expect(found).toContain('photo_alt_missing:alt:en');
  });
  it('a one-character body text is only advice, a one-character meta is a blocker', () => {
    const row = report.products.find((p) => p.sku === 'SKU-zerowidth');
    expect(row?.findings.find((f) => f.field === 'description' && f.locale === 'uk')).toMatchObject(
      { code: 'too_short', severity: 'warning' },
    );
  });
  it('an excluded (noindex) active product blocks, a variant SKU over the feed limit blocks', () => {
    expect(codes('noindex')).toEqual(['noindex']);
    expect(codes('longsku')).toEqual(['variant_sku_too_long']);
  });
  it('the same meta snippet in both languages blocks', () => {
    expect(codes('copymeta')).toEqual(['same_in_both_languages:meta_description']);
  });
  it('the long SKU really is the one the feed drops (the same limit)', () => {
    expect(FEED_MAX_ID_LENGTH).toBe(50);
  });
});

describe('categories', () => {
  it('a category with the text in one language only blocks; both missing blocks twice', async () => {
    await handle.db.execute(
      sql`UPDATE categories SET seo_text_en = NULL WHERE slug = 'hidden-cat'`,
    );
    const again = await readContentReadiness(handle.db);
    const hidden = again.categories.find((c) => c.slug === 'hidden-cat');
    expect(hidden?.findings.filter((f) => f.severity === 'blocker')).toEqual([
      { code: 'missing', severity: 'blocker', field: 'seo_text', locale: 'en', count: null },
    ]);
    const empty = again.categories.find((c) => c.slug === 'empty-cat');
    expect(empty?.ready).toBe(false);
    expect(
      empty?.findings.filter((f) => f.severity === 'blocker' && f.field === 'seo_text'),
    ).toHaveLength(2);
  });
  it('an indexable category with no live products blocks; one excluded from search needs nothing', () => {
    const nolive = report.categories.find((c) => c.slug === 'nolive-cat');
    expect(nolive?.findings.filter((f) => f.severity === 'blocker').map((f) => f.code)).toEqual([
      'no_products',
    ]);
    expect(nolive?.ready).toBe(false);
    const hidden = report.categories.find((c) => c.slug === 'noindex-cat');
    expect(hidden?.ready).toBe(true);
    expect(hidden?.findings.some((f) => f.severity === 'blocker')).toBe(false);
  });
  it('a parent counts the live products of its subcategories', async () => {
    const [parent] = (
      await handle.db.execute(
        sql`INSERT INTO categories (slug, name_uk, name_en, seo_text_uk, seo_text_en, depth)
            VALUES ('parent-cat', 'Батьківська', 'Parent', ${`<p>${filler('p', 300)}</p>`}, ${`<p>${filler('q', 300)}</p>`}, 0)
            RETURNING id`,
      )
    ).rows;
    await handle.db.execute(
      sql`UPDATE categories SET parent_id = ${String(parent?.['id'])}::uuid, depth = 1 WHERE slug = 'ready-cat'`,
    );
    const again = await readContentReadiness(handle.db);
    const row = again.categories.find((c) => c.slug === 'parent-cat');
    expect(row?.liveProductCount).toBeGreaterThan(0);
    expect(row?.findings.some((f) => f.code === 'no_products')).toBe(false);
    await handle.db.execute(
      sql`UPDATE categories SET parent_id = NULL, depth = 0 WHERE slug = 'ready-cat'`,
    );
    await handle.db.execute(sql`DELETE FROM categories WHERE slug = 'parent-cat'`);
  });
  it('the text length is the visible text: tags and invisible characters do not count', async () => {
    const ready = report.categories.find((c) => c.slug === 'ready-cat');
    expect(ready?.seoTextLengthUk).toBe(400);
    await handle.db.execute(
      sql`UPDATE categories SET seo_text_uk = '<p>&nbsp;</p><p><br></p>' WHERE slug = 'ready-cat'`,
    );
    const again = await readContentReadiness(handle.db);
    expect(again.categories.find((c) => c.slug === 'ready-cat')?.seoTextLengthUk).toBe(0);
    await handle.db.execute(
      sql`UPDATE categories SET seo_text_uk = '<p>${sql.raw(filler('seo uk', 400))}</p>' WHERE slug = 'ready-cat'`,
    );
  });
});

describe('the gate and the totals', () => {
  it('fails while any active product or active category has a blocker; names the checks', () => {
    expect(report.gatePassed).toBe(false);
    const check = (id: string) => report.acceptance.find((c) => c.id === id);
    expect(check('active_products')?.ok).toBe(false);
    expect(check('alt_meta_photo')?.ok).toBe(false);
    expect(check('category_seo_text')?.actual).toBe(1);
    expect(check('no_blockers')?.ok).toBe(false);
    expect(report.totals.drafts).toBe(1);
    expect(report.totals.live).toBeLessThan(report.totals.active);
  });
  it('passes on a clean catalogue with the expected number of live products', async () => {
    const clean = await createTestDatabase();
    const h = createDb(clean.appUrl, { max: 2 });
    try {
      await h.db.transaction(async (tx) => {
        const dict = await seedDictionaries(tx);
        await tx.execute(sql`UPDATE categories SET is_active = false WHERE slug <> 'ready-cat'`);
        for (const key of ['a', 'b', 'c'])
          await addProduct(tx, dict, { key, categoryId: dict.categoryId });
        await addProduct(tx, dict, {
          key: 'd',
          categoryId: dict.categoryId,
          product: { isActive: false, publishedAt: null, metaDescriptionEn: null },
        });
      });
      const pass = await readContentReadiness(h.db, { expectedActive: 3 });
      expect(pass.gatePassed).toBe(true);
      expect(pass.totals).toMatchObject({ live: 3, liveReady: 3, drafts: 1, draftsReady: 0 });
      // The same catalogue needs four live products: a count below the target fails the gate alone.
      expect((await readContentReadiness(h.db, { expectedActive: 4 })).gatePassed).toBe(false);
    } finally {
      await h.close();
      await clean.drop();
    }
  });
});

describe('the image URL rule agrees with safeMediaUrl', () => {
  it('flags exactly the URLs the storefront refuses', async () => {
    const urls = [
      'https://media.example.test/a.webp',
      '/media/a.webp',
      '/',
      'http://media.example.test/a.webp',
      '//evil.example/a.webp',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://media.example.test/a b.webp',
      'https://media.example.test/a"b.webp',
      "https://media.example.test/a'b.webp",
      'https://media.example.test/a\\b.webp',
      'https://media.example.test/a\tb.webp',
      '',
      ' https://media.example.test/a.webp',
    ];
    const [product] = await handle.db
      .select({ id: products.id })
      .from(products)
      .where(sql`sku = 'SKU-good'`);
    if (product === undefined) throw new Error('product');
    const tagged: { id: string; url: string }[] = [];
    for (const url of urls) {
      const id = crypto.randomUUID();
      await handle.db
        .insert(productImages)
        .values({ id, productId: product.id, url, variants: {} });
      tagged.push({ id, url });
    }
    const result = await handle.db.execute(sql`
      SELECT i.id, NOT (btrim(i.url) ~ ${URL_SAFE_PATTERN}) AS bad
        FROM product_images i WHERE i.id IN (${sql.join(
          tagged.map((t) => sql`${t.id}::uuid`),
          sql`, `,
        )})`);
    const flagged = new Map(result.rows.map((r) => [String(r['id']), r['bad'] === true]));
    for (const { id, url } of tagged)
      expect([url, flagged.get(id)]).toEqual([url, safeMediaUrl(url) === null]);
    await handle.db.execute(
      sql`DELETE FROM product_images WHERE id IN (${sql.join(
        tagged.map((t) => sql`${t.id}::uuid`),
        sql`, `,
      )})`,
    );
  });
});

describe('read only', () => {
  it('a write inside the read-only transaction the CLI uses is refused by Postgres', async () => {
    await expect(
      handle.db.transaction(
        async (tx) => {
          await readContentReadiness(tx);
          await tx.execute(sql`UPDATE products SET brand = 'x'`);
        },
        { accessMode: 'read only' },
      ),
    ).rejects.toThrow();
  });
});

describe('a large catalogue', () => {
  it('5 000 products: a constant number of queries, in seconds', async () => {
    const big = await createTestDatabase();
    const h = createDb(big.appUrl, { max: 2 });
    try {
      const dict = await h.db.transaction(async (tx) => await seedDictionaries(tx));
      await h.db.execute(sql`
        INSERT INTO products (sku, slug, brand, category_id, name_uk, name_en, meta_title_uk, meta_title_en,
                              meta_description_uk, meta_description_en, base_price, is_active, published_at)
        SELECT 'B-' || n, 'big-' || n, 'Brand', ${dict.categoryId}::uuid, 'Назва ' || n, 'Name ' || n,
               'Заголовок ' || n, 'Title ' || n, 'Опис ' || n, 'Description ' || n, 100000, true, now()
          FROM generate_series(1, 5000) n`);
      await h.db.execute(sql`
        INSERT INTO product_variants (product_id, size_id, color_id, sku, stock_quantity)
        SELECT p.id, ${dict.sizeId}::uuid, ${dict.colorId}::uuid, 'BV-' || p.sku, 3 FROM products p`);
      await h.db.execute(sql`
        INSERT INTO product_images (product_id, url, variants, width, height)
        SELECT p.id, 'https://media.example.test/' || p.id || '.webp', '{}'::jsonb, 1200, 1500
          FROM products p, generate_series(1, 3)`);
      let queries = 0;
      const counting = {
        select: h.db.select.bind(h.db),
        execute: (query: Parameters<typeof h.db.execute>[0]) => {
          queries += 1;
          return h.db.execute(query);
        },
      } as unknown as Parameters<typeof readContentReadiness>[0];
      const started = performance.now();
      const result = await readContentReadiness(counting);
      const seconds = (performance.now() - started) / 1000;
      expect(result.totals.products).toBe(5000);
      expect(result.totals.photos).toBe(15_000);
      expect(result.products).toHaveLength(2000);
      expect(result.productsTruncated).toBe(true);
      expect(result.photoProblems).toHaveLength(500);
      expect(queries).toBeLessThanOrEqual(5);
      expect(seconds).toBeLessThan(10);
    } finally {
      await h.close();
      await big.drop();
    }
  }, 120_000);
});
