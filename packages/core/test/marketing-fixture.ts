import pg from 'pg';

import type { DbHandle } from '@store/db/client';
import { sql } from 'drizzle-orm';

import type { TestWorld } from './fixtures.ts';

let seq = 0;

/** Makes the skeleton's product buyable on the storefront (published, active, in stock). */
export async function publishSkeleton(admin: DbHandle): Promise<void> {
  await admin.db.execute(
    sql`UPDATE products SET is_active = true, published_at = now() - interval '1 day'`,
  );
  await admin.db.execute(sql`UPDATE categories SET is_active = true`);
  await admin.db.execute(sql`UPDATE product_variants SET is_active = true, stock_quantity = 20`);
}

export interface CartSpec {
  email?: string;
  /** The account flag (`customers.accepts_marketing`). */
  marketing?: boolean;
  /** An active, confirmed `newsletter_subscribers` row. */
  subscribed?: boolean;
  idleHours?: number;
  items?: number;
  locale?: 'uk' | 'en';
}

/** Idle time cannot be set through the app role: the touch trigger resets `updated_at`, so the owner role switches it off for one statement. */
export async function backdateCart(
  world: TestWorld,
  cartId: string,
  idleHours: number,
): Promise<void> {
  const client = new pg.Client({ connectionString: world.testDb.migrateUrl });
  await client.connect();
  try {
    await client.query('ALTER TABLE carts DISABLE TRIGGER carts_touch_updated_at');
    await client.query(
      `UPDATE carts SET updated_at = now() - make_interval(hours => $1) WHERE id = $2::uuid`,
      [idleHours, cartId],
    );
    await client.query('ALTER TABLE carts ENABLE TRIGGER carts_touch_updated_at');
  } finally {
    await client.end();
  }
}

/** A customer with a cart of `items` lines; returns the ids. */
export async function customerCart(
  world: TestWorld,
  admin: DbHandle,
  spec: CartSpec = {},
): Promise<{ cartId: string; customerId: string; email: string; subscriberId: string | null }> {
  seq += 1;
  const email = spec.email ?? `shopper${String(seq)}@example.test`;
  const customer = await admin.db.execute<{ id: string }>(
    sql`INSERT INTO customers (email, accepts_marketing, locale)
        VALUES (${email}, ${spec.marketing ?? true}, ${spec.locale ?? 'uk'}) RETURNING id`,
  );
  const customerId = customer.rows[0]?.id ?? '';
  let subscriberId: string | null = null;
  if (spec.subscribed ?? true) {
    const sub = await admin.db.execute<{ id: string }>(
      sql`INSERT INTO newsletter_subscribers (email, locale, source, confirmed_at)
          VALUES (${email}, ${spec.locale ?? 'uk'}, 'account', now()) RETURNING id`,
    );
    subscriberId = sub.rows[0]?.id ?? null;
  }
  const cart = await admin.db.execute<{ id: string }>(
    sql`INSERT INTO carts (token, customer_id) VALUES (${`cart-token-${String(seq)}`.padEnd(32, 'x')}, ${customerId}::uuid) RETURNING id`,
  );
  const cartId = cart.rows[0]?.id ?? '';
  const variants = world.fixture.variantIds.slice(0, spec.items ?? 1);
  for (const variantId of variants) {
    await admin.db.execute(
      sql`INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES (${cartId}::uuid, ${variantId}::uuid, 1)`,
    );
  }
  return { cartId, customerId, email, subscriberId };
}
