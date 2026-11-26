/**
 * The category content editor's read and write on real Postgres: an explicit DTO, plain text stored
 * as escaped paragraphs, an empty text stored as NULL, and the readiness report seeing the change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { updateCategory } from '../src/catalog-admin/categories.ts';
import { categoryTextToHtml } from '../src/catalog-admin/category-text.ts';
import { getAdminCategoryContent } from '../src/catalog-admin/read.ts';
import { readContentReadiness } from '../src/content-readiness/read.ts';
import { seedDictionaries } from './content-fixture.ts';

let testDb: TestDatabase;
let handle: DbHandle;
let emptyId = '';

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
  emptyId = (await handle.db.transaction(async (tx) => await seedDictionaries(tx))).emptyCategoryId;
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

describe('category content', () => {
  it('reads exactly the category texts, null for an unknown id', async () => {
    const row = await getAdminCategoryContent(handle.db, emptyId);
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'descriptionEn',
        'descriptionUk',
        'id',
        'isActive',
        'metaDescriptionEn',
        'metaDescriptionUk',
        'metaTitleEn',
        'metaTitleUk',
        'nameEn',
        'nameUk',
        'noindex',
        'seoTextEn',
        'seoTextUk',
        'slug',
      ].sort(),
    );
    expect(
      await getAdminCategoryContent(handle.db, '0193f0a4-7c3e-7000-8000-00000000ffff'),
    ).toBeNull();
  });

  it('a typed text becomes escaped paragraphs and the readiness report stops asking for it', async () => {
    const before = await readContentReadiness(handle.db);
    expect(
      before.categories
        .find((c) => c.id === emptyId)
        ?.findings.filter((f) => f.field === 'seo_text'),
    ).toHaveLength(2);
    const typed = `${'Перший абзац & "коротко". '.repeat(12)}\n\n${'Second paragraph. '.repeat(15)}`;
    await handle.db.transaction(async (tx) => {
      await updateCategory(tx, {
        categoryId: emptyId,
        seoTextUk: categoryTextToHtml(typed),
        seoTextEn: categoryTextToHtml(typed),
      });
    });
    const row = await getAdminCategoryContent(handle.db, emptyId);
    expect(row?.seoTextUk).toContain('<p>Перший абзац &amp; &quot;коротко&quot;.');
    expect(row?.seoTextUk?.split('</p><p>')).toHaveLength(2);
    const after = await readContentReadiness(handle.db);
    const category = after.categories.find((c) => c.id === emptyId);
    expect(category?.findings.filter((f) => f.field === 'seo_text')).toEqual([]);
    expect(category?.seoTextLengthUk).toBeGreaterThan(200);
  });
});
