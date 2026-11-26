/**
 * Wishlist and back-in-stock alerts on real Postgres, with TWO customers: ownership, visibility, the
 * single claim of a restock under parallel workers (separate pools), one queue row per alert with the id
 * as the only payload, re-arming, and the unsubscribe token.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { auditLog, customers, outbox, stockNotifications } from '@store/db/schema';

import {
  AlertNotNeededError,
  AlertVariantNotFoundError,
  buildUnsubscribeToken,
  cancelStockAlert,
  listMyStockAlerts,
  notifyRestocked,
  readUnsubscribeToken,
  subscribeStockAlert,
  unsubscribeByToken,
} from '../src/account/stock-alerts.ts';
import {
  WishlistProductNotFoundError,
  addToWishlist,
  listMyWishlist,
  removeFromWishlist,
} from '../src/account/wishlist.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
let world: TestWorld;
let handle: DbHandle;
let a: { customerId: string; userId: string; email: string; locale: 'uk'; ip: null };
let b: typeof a;
let productId = '';
let [variantOne, variantTwo]: [string, string] = ['', ''];

async function customer(email: string): Promise<typeof a> {
  const [user] = await handle.db
    .execute<{ id: string }>(
      sql`INSERT INTO auth_users (email, email_verified_at) VALUES (${email}, now()) RETURNING id`,
    )
    .then((r) => r.rows);
  const [row] = await handle.db
    .insert(customers)
    .values({ email, userId: user?.id ?? null })
    .returning({ id: customers.id });
  return { customerId: row?.id ?? '', userId: user?.id ?? '', email, locale: 'uk', ip: null };
}
const setStock = async (variant: string, stock: number, reserved = 0) => {
  await handle.db.execute(
    sql`UPDATE product_variants SET stock_quantity = ${stock}, reserved_quantity = ${reserved} WHERE id = ${variant}`,
  );
};
const run = async (h: DbHandle = handle) =>
  await h.db.transaction(async (tx) => await notifyRestocked(tx));
const queued = async () =>
  (await handle.db.select().from(outbox)).filter((row) => row.topic === 'email.back-in-stock');

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(10);
  a = await customer('a@example.test');
  b = await customer('b@example.test');
  productId = world.fixture.productId;
  [variantOne, variantTwo] = world.fixture.variantIds;
  // The skeleton product is not published until it is made visible.
  await handle.db.execute(
    sql`UPDATE products SET is_active = true, published_at = now() - interval '1 day' WHERE id = ${productId}`,
  );
  await handle.db.execute(sql`UPDATE categories SET is_active = true`);
});
afterAll(async () => {
  await world.close();
});

describe('wishlist', () => {
  it('adds once, lists only mine, removes only mine', async () => {
    expect(await handle.db.transaction(async (tx) => await addToWishlist(tx, a, productId))).toBe(
      true,
    );
    expect(await handle.db.transaction(async (tx) => await addToWishlist(tx, a, productId))).toBe(
      false,
    );
    expect((await listMyWishlist(handle.db, a.customerId, 'uk')).map((i) => i.productId)).toEqual([
      productId,
    ]);
    expect(await listMyWishlist(handle.db, b.customerId, 'uk')).toEqual([]);
    expect(
      await handle.db.transaction(async (tx) => await removeFromWishlist(tx, b, productId)),
    ).toBe(false);
    expect(await listMyWishlist(handle.db, a.customerId, 'uk')).toHaveLength(1);
    const item = (await listMyWishlist(handle.db, a.customerId, 'en'))[0];
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'available',
      'name',
      'price',
      'productId',
      'slug',
    ]);
    expect(
      await handle.db.transaction(async (tx) => await removeFromWishlist(tx, a, productId)),
    ).toBe(true);
  });

  it('a hidden or unknown product cannot be added, and a product hidden later drops out of the list', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await addToWishlist(tx, a, '00000000-0000-4000-8000-000000000000');
      }),
    ).rejects.toBeInstanceOf(WishlistProductNotFoundError);
    await handle.db.transaction(async (tx) => {
      await addToWishlist(tx, a, productId);
    });
    await handle.db.execute(sql`UPDATE products SET is_active = false WHERE id = ${productId}`);
    expect(await listMyWishlist(handle.db, a.customerId, 'uk')).toEqual([]);
    await expect(
      handle.db.transaction(async (tx) => {
        await addToWishlist(tx, b, productId);
      }),
    ).rejects.toBeInstanceOf(WishlistProductNotFoundError);
    await handle.db.execute(sql`UPDATE products SET is_active = true WHERE id = ${productId}`);
  });
});

describe('back-in-stock alerts', () => {
  it('only a size that cannot be bought now can be followed; an unknown or hidden one is "not found"', async () => {
    await setStock(variantOne, 3);
    await expect(
      handle.db.transaction(async (tx) => {
        await subscribeStockAlert(tx, a, variantOne);
      }),
    ).rejects.toBeInstanceOf(AlertNotNeededError);
    await expect(
      handle.db.transaction(async (tx) => {
        await subscribeStockAlert(tx, a, 'nope');
      }),
    ).rejects.toBeInstanceOf(AlertVariantNotFoundError);
    await setStock(variantOne, 0);
    await handle.db.execute(sql`UPDATE products SET is_active = false WHERE id = ${productId}`);
    await expect(
      handle.db.transaction(async (tx) => {
        await subscribeStockAlert(tx, a, variantOne);
      }),
    ).rejects.toBeInstanceOf(AlertVariantNotFoundError);
    await handle.db.execute(sql`UPDATE products SET is_active = true WHERE id = ${productId}`);
  });

  it('subscribes once per (size, address); lists and cancels only mine', async () => {
    const first = await handle.db.transaction(
      async (tx) => await subscribeStockAlert(tx, a, variantOne),
    );
    const again = await handle.db.transaction(
      async (tx) => await subscribeStockAlert(tx, a, variantOne),
    );
    expect(again).toBe(first);
    expect(
      await handle.db
        .select()
        .from(stockNotifications)
        .where(eq(stockNotifications.email, a.email)),
    ).toHaveLength(1);
    expect((await listMyStockAlerts(handle.db, a.email, 'uk')).map((x) => x.id)).toEqual([first]);
    expect(await listMyStockAlerts(handle.db, b.email, 'uk')).toEqual([]);
    expect(await handle.db.transaction(async (tx) => await cancelStockAlert(tx, b, first))).toBe(
      false,
    );
    expect(
      await handle.db.select().from(stockNotifications).where(eq(stockNotifications.id, first)),
    ).toHaveLength(1);
  });

  it('while the size is unavailable nothing is queued; a reservation that eats the stock keeps it unavailable', async () => {
    await setStock(variantOne, 5, 5);
    expect(await run()).toBe(0);
    expect(await queued()).toHaveLength(0);
  });

  it('a restock queues ONE mail per alert with the id as the only payload, and a second run queues none', async () => {
    await handle.db.transaction(async (tx) => {
      await subscribeStockAlert(tx, b, variantOne);
    });
    await setStock(variantOne, 5);
    expect(await run()).toBe(2);
    expect(await run()).toBe(0);
    const rows = await queued();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row.payload as object)).toEqual(['alertId']);
      expect(JSON.stringify(row.payload)).not.toContain('@');
    }
  });

  it('PARALLEL workers (separate pools) claim each alert exactly once', async () => {
    await setStock(variantTwo, 0);
    const people = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => await customer(`p${String(i)}@example.test`)),
    );
    for (const person of people) {
      await handle.db.transaction(async (tx) => {
        await subscribeStockAlert(tx, person, variantTwo);
      });
    }
    const before = (await queued()).length;
    await setStock(variantTwo, 10);
    const barrier = new Barrier(4);
    const pools = Array.from({ length: 4 }, () => world.connect(1));
    const counts = await Promise.all(
      pools.map(async (pool) => {
        await barrier.wait();
        return await run(pool);
      }),
    );
    expect(counts.reduce((x, y) => x + y, 0)).toBe(6);
    expect((await queued()).length - before).toBe(6);
  });

  it('resubscribing after the alert was sent re-arms it, and it can be sent again', async () => {
    await setStock(variantOne, 0);
    await handle.db.transaction(async (tx) => {
      await subscribeStockAlert(tx, a, variantOne);
    });
    const [row] = await handle.db
      .select()
      .from(stockNotifications)
      .where(eq(stockNotifications.email, a.email));
    expect(row?.notifiedAt).toBeNull();
    const before = (await queued()).length;
    await setStock(variantOne, 4);
    expect(await run()).toBe(1);
    expect((await queued()).length - before).toBe(1);
  });

  it('the unsubscribe token: works without a session, is idempotent, forged and foreign-secret tokens do nothing', async () => {
    await setStock(variantOne, 0);
    const id = await handle.db.transaction(
      async (tx) => await subscribeStockAlert(tx, b, variantOne),
    );
    const token = buildUnsubscribeToken(SECRET, id);
    expect(readUnsubscribeToken('x'.repeat(40), token)).toBeNull();
    expect(readUnsubscribeToken(SECRET, `${id}.${'A'.repeat(43)}`)).toBeNull();
    expect(readUnsubscribeToken(SECRET, `${id}.`)).toBeNull();
    expect(
      await handle.db.transaction(
        async (tx) => await unsubscribeByToken(tx, SECRET, `${id}.${'A'.repeat(43)}`),
      ),
    ).toBe(false);
    expect(
      await handle.db.select().from(stockNotifications).where(eq(stockNotifications.id, id)),
    ).toHaveLength(1);
    expect(
      await handle.db.transaction(async (tx) => await unsubscribeByToken(tx, SECRET, token)),
    ).toBe(true);
    expect(
      await handle.db.transaction(async (tx) => await unsubscribeByToken(tx, SECRET, token)),
    ).toBe(true);
    expect(
      await handle.db.select().from(stockNotifications).where(eq(stockNotifications.id, id)),
    ).toHaveLength(0);
    expect(() => buildUnsubscribeToken(undefined, id)).toThrow();
    // A mail link of one alert never opens another (the id is signed).
    const other = await handle.db.transaction(
      async (tx) => await subscribeStockAlert(tx, a, variantOne),
    );
    expect(readUnsubscribeToken(SECRET, `${other}.${token.split('.')[1] ?? ''}`)).toBeNull();
  });

  it('audits changes with the account as author and never the address', async () => {
    const rows = await handle.db.select().from(auditLog);
    expect(rows.some((r) => r.action === 'customer.stock_alert_added')).toBe(true);
    expect(rows.some((r) => r.action === 'customer.wishlist_added')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('@example');
  });
});
