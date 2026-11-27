/**
 * The product view counter on real Postgres: one row per product, session hash and UTC day; only a
 * product the storefront shows counts; the answer reveals nothing; old rows go by the database date.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { productViews, products } from '@store/db/schema';

import {
  purgeProductViews,
  recordProductView,
  viewSessionHash,
} from '../src/product-views/views.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let productId: string;
const hash = (n: number): string => String(n).padStart(64, '0');

beforeAll(async () => {
  world = await createWorld();
  productId = world.fixture.productId;
  await world
    .connect(1)
    .db.execute(sql`UPDATE products SET published_at = now() - interval '1 day'`);
});
afterAll(async () => {
  await world.close();
});

const count = async (): Promise<number> => {
  const rows = await world
    .connect(1)
    .db.select({ n: sql<number>`count(*)::int` })
    .from(productViews);
  return rows[0]?.n ?? 0;
};

describe('recordProductView', () => {
  it('counts a view once per session per day and a second session separately', async () => {
    const { db } = world.connect(1);
    const first = await db.transaction(
      async (tx) => await recordProductView(tx, { productId, sessionHash: hash(1) }),
    );
    const again = await db.transaction(
      async (tx) => await recordProductView(tx, { productId, sessionHash: hash(1) }),
    );
    const other = await db.transaction(
      async (tx) => await recordProductView(tx, { productId, sessionHash: hash(2) }),
    );
    expect([first, again, other]).toEqual([true, false, true]);
    expect(await count()).toBe(2);
  });

  it('counts concurrent identical views once (the unique index decides)', async () => {
    const before = await count();
    const handles = [world.connect(1), world.connect(1), world.connect(1), world.connect(1)];
    const results = await Promise.all(
      handles.map(
        async ({ db }) =>
          await db.transaction(
            async (tx) => await recordProductView(tx, { productId, sessionHash: hash(77) }),
          ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await count()).toBe(before + 1);
  });

  it('writes nothing for an unknown id, a draft, an inactive product or a gift card', async () => {
    const { db } = world.connect(1);
    const before = await count();
    const unknown = await db.transaction(
      async (tx) =>
        await recordProductView(tx, {
          productId: '00000000-0000-4000-8000-0000000000aa',
          sessionHash: hash(3),
        }),
    );
    expect(unknown).toBe(false);
    for (const change of [
      sql`published_at = NULL`,
      sql`published_at = now() + interval '1 day'`,
      sql`published_at = now() - interval '1 day', is_active = false`,
      sql`is_active = true, kind = 'gift_card'`,
    ]) {
      await db.execute(sql`UPDATE products SET ${change}`);
      const written = await db.transaction(
        async (tx) => await recordProductView(tx, { productId, sessionHash: hash(4) }),
      );
      expect(written).toBe(false);
    }
    await db
      .update(products)
      .set({ isActive: true, kind: 'physical', publishedAt: new Date(Date.now() - 86_400_000) });
    expect(await count()).toBe(before);
  });

  it('stores no address, agent or customer: the row is the product, an opaque hash and a day', async () => {
    const { db } = world.connect(1);
    const rows = await db.execute(sql`SELECT * FROM product_views LIMIT 1`);
    expect(Object.keys(rows.rows[0] ?? {}).sort()).toEqual([
      'created_at',
      'id',
      'product_id',
      'session_hash',
      'viewed_on',
    ]);
  });
});

describe('purgeProductViews', () => {
  it('removes rows older than 90 days by the database date and keeps the rest', async () => {
    const { db } = world.connect(1);
    await db.execute(sql`DELETE FROM product_views`);
    await db.execute(sql`INSERT INTO product_views (product_id, session_hash, viewed_on) VALUES
      (${productId}::uuid, ${hash(10)}, (now() AT TIME ZONE 'UTC')::date - 91),
      (${productId}::uuid, ${hash(11)}, (now() AT TIME ZONE 'UTC')::date - 90),
      (${productId}::uuid, ${hash(12)}, (now() AT TIME ZONE 'UTC')::date - 89),
      (${productId}::uuid, ${hash(13)}, (now() AT TIME ZONE 'UTC')::date)`);
    const removed = await purgeProductViews(db);
    expect(removed).toBe(1);
    expect(await count()).toBe(3);
    expect(await db.transaction(async (tx) => await purgeProductViews(tx, { keepDays: 1 }))).toBe(
      2,
    );
  });
});

describe('purgeProductViews in batches', () => {
  it('removes a backlog larger than one batch in several short transactions, and stops at the round cap', async () => {
    const { db } = world.connect(1);
    await db.execute(sql`DELETE FROM product_views`);
    await db.execute(sql`INSERT INTO product_views (product_id, session_hash, viewed_on)
      SELECT ${productId}::uuid, md5(g::text) || md5((g + 1)::text), (now() AT TIME ZONE 'UTC')::date - 100 - (g % 50)
        FROM generate_series(1, 12000) g`);
    await db.execute(sql`INSERT INTO product_views (product_id, session_hash, viewed_on)
      VALUES (${productId}::uuid, ${hash(900)}, (now() AT TIME ZONE 'UTC')::date)`);
    // Capped: 2 rounds of 5000 leave 2000 old rows; the next run finishes the work.
    expect(await purgeProductViews(db, { batchSize: 5000, maxRounds: 2 })).toBe(10_000);
    expect(await count()).toBe(2_001);
    expect(await purgeProductViews(db, { batchSize: 5000 })).toBe(2_000);
    expect(await count()).toBe(1);
  });
});

describe('viewSessionHash', () => {
  const base = { day: '2026-11-27', client: '203.0.113.9' };
  it('is deterministic, opaque and changes with the day, the client and the secret, and never with a user agent', () => {
    const a = viewSessionHash('secret', base);
    expect(a).toBe(viewSessionHash('secret', base));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203');
    expect(
      new Set([
        a,
        viewSessionHash('secret', { ...base, day: '2026-11-28' }),
        viewSessionHash('secret', { ...base, client: '203.0.113.10' }),
        viewSessionHash('other', base),
      ]).size,
    ).toBe(4);
  });
});
