/**
 * 410 for a page that is gone and the hit counter, on real Postgres: a gone path is stored for
 * both locales, a reused slug is released again, and counted hits are added in one statement.
 */
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '@store/db/client';
import { redirects } from '@store/db/schema';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import {
  addRedirectHits,
  listRedirects,
  recordGone,
  recordSlugRedirects,
  releaseSlugPaths,
} from '../src/catalog-admin/redirects.ts';

let testDb: TestDatabase;
let handle: DbHandle;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

const rowOf = async (from: string) =>
  (await handle.db.select().from(redirects).where(eq(redirects.fromPath, from)))[0];

describe('recordGone', () => {
  it('stores a 410 for both locales, and the proxy loader lists it', async () => {
    await handle.db.transaction(async (tx) => {
      await recordGone(tx, { kind: 'product', slug: 'discontinued' });
    });
    expect((await rowOf('/product/discontinued'))?.statusCode).toBe(410);
    expect((await rowOf('/en/product/discontinued'))?.statusCode).toBe(410);
    const listed = await listRedirects(handle.db);
    expect(listed.filter((r) => r.statusCode === 410).map((r) => r.fromPath)).toEqual(
      expect.arrayContaining(['/product/discontinued', '/en/product/discontinued']),
    );
  });

  it('removes redirects that pointed at the gone page (no hop to a 410)', async () => {
    await handle.db.transaction(async (tx) => {
      await recordSlugRedirects(tx, { kind: 'category', fromSlug: 'a-old', toSlug: 'a-mid' });
      await recordGone(tx, { kind: 'category', slug: 'a-mid' });
    });
    expect(await rowOf('/category/a-old')).toBeUndefined();
    expect((await rowOf('/category/a-mid'))?.statusCode).toBe(410);
  });

  it('a reused slug is live again: releasing it deletes the 410', async () => {
    await handle.db.transaction(async (tx) => {
      await recordGone(tx, { kind: 'product', slug: 'comeback' });
      await releaseSlugPaths(tx, 'product', 'comeback');
    });
    expect(await rowOf('/product/comeback')).toBeUndefined();
    expect(await rowOf('/en/product/comeback')).toBeUndefined();
  });

  it('is idempotent and turns an earlier 301 from the same path into a 410', async () => {
    await handle.db.transaction(async (tx) => {
      await recordSlugRedirects(tx, { kind: 'product', fromSlug: 'twice', toSlug: 'twice-new' });
      await recordGone(tx, { kind: 'product', slug: 'twice' });
      await recordGone(tx, { kind: 'product', slug: 'twice' });
    });
    const row = await rowOf('/product/twice');
    expect(row?.statusCode).toBe(410);
  });
});

describe('addRedirectHits', () => {
  it('adds counts in one statement, ignores unknown paths and bad counts', async () => {
    await handle.db.transaction(async (tx) => {
      await recordSlugRedirects(tx, { kind: 'product', fromSlug: 'h1', toSlug: 'h1-new' });
    });
    await addRedirectHits(
      handle.db,
      new Map([
        ['/product/h1', 5],
        ['/en/product/h1', 2],
        ['/product/never-existed', 9],
        ['/product/h1-new', 0],
      ]),
    );
    await addRedirectHits(handle.db, new Map([['/product/h1', 3]]));
    expect((await rowOf('/product/h1'))?.hitCount).toBe(8);
    expect((await rowOf('/en/product/h1'))?.hitCount).toBe(2);
    expect(await rowOf('/product/never-existed')).toBeUndefined();
    await addRedirectHits(handle.db, new Map());
    const all = await handle.db
      .select({ n: redirects.hitCount })
      .from(redirects)
      .where(inArray(redirects.fromPath, ['/product/h1']));
    expect(all[0]?.n).toBe(8);
  });
});
