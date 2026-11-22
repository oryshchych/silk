/**
 * createOrder on real Postgres. Every concurrency scenario uses separate pools
 * (separate connections) and a barrier, so the "parallel" calls really overlap.
 * Phase 0.5 criteria 1-4 and the atomicity rule of AGENTS.md 4b.1.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { productVariants, products } from '@store/db/schema';
import type { DbHandle } from '@store/db/client';
import { money } from '@store/shared/money';

import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import {
  CartConvertedError,
  InsufficientStockError,
  IntentExpiredError,
  IntentNotFoundError,
  IntentPayloadMismatchError,
  InvalidCartTokenError,
  PromoRejectedError,
  StaleCartError,
  UnsupportedPurchaseError,
  VariantNotFoundError,
} from '../src/errors.ts';
import { reserveStock, type CheckoutLine } from '../src/orders/checkout-lines.ts';
import { createOrder, type CreateOrderInput } from '../src/orders/create-order.ts';
import { consumePromoUse } from '../src/orders/persist-order.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;
let v1: string;
let v2: string;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  [v1, v2] = world.fixture.variantIds;
});

afterEach(async () => {
  await world.close();
});

/** Cart tokens are high-entropy in production; tests use readable ones of valid shape. */
const tok = (name: string): string => `tok-${name}`.padEnd(20, 'x');

const details = (intentId: string, name: string, over: Partial<CreateOrderInput> = {}) =>
  ({
    intentId,
    ownerToken: tok(name),
    contact: { email: 'buyer@example.com', phone: '+380501112233', name: 'Buyer' },
    delivery: { method: 'pickup' },
    paymentProvider: 'mono',
    promoCode: null,
    locale: 'uk',
    ...over,
  }) satisfies CreateOrderInput;

async function fillCart(name: string, items: [string, number][]): Promise<void> {
  for (const [variantId, quantity] of items) {
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, { cartToken: tok(name), variantId, quantity });
    });
  }
}

async function intentFor(name: string): Promise<string> {
  const view = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: tok(name) }),
  );
  return view.intentId;
}

/** Runs createOrder in its own transaction on its own connection. */
async function placeOrder(input: CreateOrderInput, handle: DbHandle = world.connect()) {
  return await handle.db.transaction(async (tx) => await createOrder(tx, input));
}

async function count(table: string): Promise<number> {
  const result = await admin.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
  );
  return result.rows[0]?.n ?? -1;
}

async function stock(variantId: string): Promise<{ stock: number; reserved: number }> {
  const [row] = await admin.db
    .select({ stock: productVariants.stockQuantity, reserved: productVariants.reservedQuantity })
    .from(productVariants)
    .where(eq(productVariants.id, variantId));
  return row ?? { stock: -1, reserved: -1 };
}

/**
 * Deterministic overlap proof. Runs createOrder, keeps its transaction OPEN and
 * returns a release switch. A caller that then starts a second operation and
 * sees it blocked on a lock (waitUntilBlocked) has proof that the two really
 * overlapped, instead of running back-to-back.
 */
async function heldOrder(input: CreateOrderInput) {
  const handle = world.connect();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = handle.db.transaction(async (tx) => {
    const result = await createOrder(tx, input);
    ready();
    await gate;
    return result;
  });
  done.catch(() => {
    ready();
  });
  await started;
  return { release, done };
}

async function waitUntilBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('no backend ever blocked on a lock: the operations did not overlap');
}

const settle = async <T>(promises: Promise<T>[]) => await Promise.allSettled(promises);

describe('criterion 1: two simultaneous orders for the last unit', () => {
  it('one succeeds, the other gets the list of problem items', async () => {
    await fillCart('buyer-a', [[v1, 1]]);
    await fillCart('buyer-b', [[v1, 1]]);
    const [a, b] = [await intentFor('buyer-a'), await intentFor('buyer-b')];
    const barrier = new Barrier(2);
    const run = async (intent: string, token: string) => {
      const handle = world.connect(); // connection opened BEFORE the barrier
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await placeOrder(details(intent, token), handle);
    };

    const results = await settle([run(a, 'buyer-a'), run(b, 'buyer-b')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const error: unknown = failed[0]?.reason;
    if (!(error instanceof InsufficientStockError))
      throw new Error('expected InsufficientStockError');
    expect(error.problems).toEqual([{ variantId: v1, requested: 1, available: 0 }]);

    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 });
    expect(await count('orders')).toBe(1);
    expect(await count('stock_reservations')).toBe(1);
  });

  it('lists every problem position, not just the first', async () => {
    await fillCart('first', [
      [v1, 1],
      [v2, 1],
    ]);
    await fillCart('second', [
      [v1, 1],
      [v2, 1],
    ]);
    await placeOrder(details(await intentFor('first'), 'first'));
    const error = await placeOrder(details(await intentFor('second'), 'second')).catch(
      (e: unknown) => e,
    );
    if (!(error instanceof InsufficientStockError))
      throw new Error('expected InsufficientStockError');
    const problems = error.problems;
    expect(problems.map((p) => p.variantId).toSorted()).toEqual([v1, v2].toSorted());
  });
});

describe('criterion 2: the same intent submitted simultaneously', () => {
  it('five parallel submissions create exactly one order', async () => {
    await fillCart('twin', [[v1, 1]]);
    const intent = await intentFor('twin');
    const barrier = new Barrier(5);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await placeOrder(details(intent, 'twin'), handle);
      }),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(await count('orders')).toBe(1);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 });
  });
});

describe('criterion 3: reload after the order was created', () => {
  it('shows the same order, not "no stock"', async () => {
    await fillCart('reload', [[v1, 1]]);
    const intent = await intentFor('reload');
    const first = await placeOrder(details(intent, 'reload'));
    expect(first.created).toBe(true);

    // The last unit is now reserved: a fresh reservation attempt would fail.
    const view = await admin.db.transaction(
      async (tx) => await startCheckout(tx, { cartToken: tok('reload') }),
    );
    expect(view.intentId).toBe(intent);
    expect(view.orderId).toBe(first.orderId);

    const again = await placeOrder(details(intent, 'reload'));
    expect(again).toMatchObject({ created: false, orderId: first.orderId, accessToken: null });
  });

  it('the same intent with a different payload is a conflict', async () => {
    await fillCart('conflict', [[v1, 1]]);
    const intent = await intentFor('conflict');
    await placeOrder(details(intent, 'conflict'));
    await expect(
      placeOrder(details(intent, 'conflict', { delivery: { method: 'np_courier', address: 'x' } })),
    ).rejects.toBeInstanceOf(IntentPayloadMismatchError);
  });
});

describe('criterion 4: the cart changes in a second tab', () => {
  it('the first tab gets a 409 and a new intent is issued', async () => {
    await fillCart('tabs', [[v1, 1]]);
    const oldIntent = await intentFor('tabs');
    await fillCart('tabs', [[v2, 1]]); // second tab adds an item

    const error = await placeOrder(details(oldIntent, 'tabs')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaleCartError);
    expect(await count('orders')).toBe(0);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });

    const fresh = await intentFor('tabs');
    expect(fresh).not.toBe(oldIntent);
    await expect(placeOrder(details(fresh, 'tabs'))).resolves.toMatchObject({ created: true });
  });

  it('an intent cannot be used with another owner token', async () => {
    await fillCart('owner', [[v1, 1]]);
    const intent = await intentFor('owner');
    await expect(
      placeOrder({ ...details(intent, 'owner'), ownerToken: tok('thief') }),
    ).rejects.toBeInstanceOf(IntentNotFoundError);
  });
});

describe('what an order contains', () => {
  it('takes prices from the database and snapshots them; reserves without touching stock', async () => {
    await fillCart('snap', [[v1, 1]]);
    const intent = await intentFor('snap');
    const result = await placeOrder(details(intent, 'snap'));

    // The price changes after the order: the order keeps the old one.
    await admin.db
      .update(products)
      .set({ basePrice: 500 })
      .where(eq(products.id, world.fixture.productId));
    const items = await admin.db.execute<{
      unit_price: number;
      name_snapshot: string;
      sku_snapshot: string;
      line_total: number;
    }>(sql`SELECT unit_price, name_snapshot, sku_snapshot, line_total FROM order_items`);
    expect(items.rows).toEqual([
      {
        unit_price: 129900,
        name_snapshot: 'Тестовий бюстгальтер',
        sku_snapshot: 'SK-001-1',
        line_total: 129900,
      },
    ]);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 });
    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await admin.db.execute<{ ttl_minutes: number; hash_len: number }>(
      sql`SELECT round(extract(epoch FROM (r.expires_at - now())) / 60)::int AS ttl_minutes,
                 length(o.access_token_hash) AS hash_len
            FROM stock_reservations r JOIN orders o ON o.id = r.order_id`,
    );
    // card payment: 30 minutes from Postgres time; only a hash of the token is stored
    expect(rows.rows[0]?.ttl_minutes).toBeGreaterThanOrEqual(29);
    expect(rows.rows[0]?.ttl_minutes).toBeLessThanOrEqual(30);
    expect(rows.rows[0]?.hash_len).toBe(64);
    expect(await count('outbox')).toBe(1);
    expect(await count('order_status_history')).toBe(2);
    expect(await count('audit_log')).toBe(1);
  });

  it('rejects the gift card provider and gift card products without creating an order', async () => {
    await fillCart('gift', [[v1, 1]]);
    const intent = await intentFor('gift');
    await expect(
      placeOrder(details(intent, 'gift', { paymentProvider: 'gift_card' })),
    ).rejects.toBeInstanceOf(UnsupportedPurchaseError);

    await admin.db
      .update(products)
      .set({ kind: 'gift_card' })
      .where(eq(products.id, world.fixture.productId));
    await expect(placeOrder(details(intent, 'gift'))).rejects.toBeInstanceOf(
      UnsupportedPurchaseError,
    );
    expect(await count('orders')).toBe(0);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });
  });
});

describe('promo codes at checkout', () => {
  const addPromo = async (maxUses: number | null, value = 1001) => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value, max_uses) VALUES ('SAVE', 'fixed', ${value}, ${maxUses})`,
    );
  };

  it('distributes the discount so line discounts add up to the order discount', async () => {
    await addPromo(null, 1001);
    await fillCart('promo', [
      [v1, 1],
      [v2, 1],
    ]);
    await placeOrder(details(await intentFor('promo'), 'promo', { promoCode: 'save' }));
    const rows = await admin.db.execute<{
      sum_lines: number;
      discount_total: number;
      min_total: number;
    }>(
      sql`SELECT (SELECT sum(line_discount)::int FROM order_items) AS sum_lines,
                 o.discount_total, (SELECT min(line_total)::int FROM order_items) AS min_total
            FROM orders o`,
    );
    expect(rows.rows[0]).toMatchObject({ sum_lines: 1001, discount_total: 1001 });
    expect(rows.rows[0]?.min_total).toBeGreaterThanOrEqual(0);
  });

  it('two checkouts racing for the last allowed use: one wins', async () => {
    await addPromo(1);
    await fillCart('p-a', [[v1, 1]]);
    await fillCart('p-b', [[v2, 1]]);
    const [a, b] = [await intentFor('p-a'), await intentFor('p-b')];
    const barrier = new Barrier(2);
    const run = async (intent: string, token: string) => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await placeOrder(details(intent, token, { promoCode: 'SAVE' }), handle);
    };
    const results = await settle([run(a, 'p-a'), run(b, 'p-b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(PromoRejectedError);
    const row = await admin.db.execute<{ uses_count: number }>(
      sql`SELECT uses_count FROM promo_codes`,
    );
    expect(row.rows[0]?.uses_count).toBe(1);
  });

  it('an unknown code is rejected before anything is reserved', async () => {
    await fillCart('nopromo', [[v1, 1]]);
    await expect(
      placeOrder(details(await intentFor('nopromo'), 'nopromo', { promoCode: 'NOPE' })),
    ).rejects.toBeInstanceOf(PromoRejectedError);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });
  });
});

describe('atomicity (AGENTS.md 4b.1): one transaction, every table', () => {
  it('a failure after createOrder rolls back the order, reservations, promo use, history, outbox', async () => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value) VALUES ('SAVE', 'fixed', 100)`,
    );
    await fillCart('atomic', [[v1, 1]]);
    const intent = await intentFor('atomic');
    const handle = world.connect();
    await expect(
      handle.db.transaction(async (tx) => {
        await createOrder(tx, details(intent, 'atomic', { promoCode: 'SAVE' }));
        throw new Error('boom after the last step');
      }),
    ).rejects.toThrow('boom');

    for (const table of [
      'orders',
      'order_items',
      'stock_reservations',
      'promo_code_redemptions',
      'order_status_history',
      'audit_log',
      'outbox',
    ]) {
      expect(await count(table), table).toBe(0);
    }
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });
    const promo = await admin.db.execute<{ uses_count: number }>(
      sql`SELECT uses_count FROM promo_codes`,
    );
    expect(promo.rows[0]?.uses_count).toBe(0);
    const intentRow = await admin.db.execute<{ completed_at: Date | null }>(
      sql`SELECT completed_at FROM checkout_intents`,
    );
    expect(intentRow.rows[0]?.completed_at).toBeNull();
  });
});

describe('proven overlap (a blocked backend is observed, not assumed)', () => {
  it('last unit: the second buyer waits for the first, then gets the problem list', async () => {
    await fillCart('o-a', [[v1, 1]]);
    await fillCart('o-b', [[v1, 1]]);
    const held = await heldOrder(details(await intentFor('o-a'), 'o-a'));
    const second = placeOrder(details(await intentFor('o-b'), 'o-b')).catch((e: unknown) => e);
    await waitUntilBlocked();
    held.release();
    await expect(held.done).resolves.toMatchObject({ created: true });
    expect(await second).toBeInstanceOf(InsufficientStockError);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 });
  });

  it('same intent: the duplicate waits and returns the existing order', async () => {
    await fillCart('o-same', [[v1, 1]]);
    const intent = await intentFor('o-same');
    const held = await heldOrder(details(intent, 'o-same'));
    const duplicate = placeOrder(details(intent, 'o-same'));
    await waitUntilBlocked();
    held.release();
    const first = await held.done;
    expect(await duplicate).toMatchObject({ created: false, orderId: first.orderId });
  });

  it('last promo use: the second checkout waits on the promo row and is rejected', async () => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value, max_uses) VALUES ('ONCE', 'fixed', 100, 1)`,
    );
    await fillCart('o-p1', [[v1, 1]]);
    await fillCart('o-p2', [[v2, 1]]);
    const held = await heldOrder(details(await intentFor('o-p1'), 'o-p1', { promoCode: 'ONCE' }));
    const second = placeOrder(
      details(await intentFor('o-p2'), 'o-p2', { promoCode: 'ONCE' }),
    ).catch((e: unknown) => e);
    await waitUntilBlocked();
    held.release();
    await held.done;
    expect(await second).toBeInstanceOf(PromoRejectedError);
    // the loser rolled back its reservation as well
    expect(await stock(v2)).toEqual({ stock: 1, reserved: 0 });
  });

  it('a cart edit during checkout waits for the cart lock, then sees a converted cart', async () => {
    await fillCart('o-edit', [[v1, 1]]);
    const held = await heldOrder(details(await intentFor('o-edit'), 'o-edit'));
    const edit = admin.db
      .transaction(
        async (tx) =>
          await setCartItem(tx, { cartToken: tok('o-edit'), variantId: v2, quantity: 1 }),
      )
      .catch((e: unknown) => e);
    await waitUntilBlocked();
    held.release();
    await held.done;
    expect(await edit).toBeInstanceOf(CartConvertedError);
  });
});

describe('converted carts and intent lifecycle', () => {
  it('after an order, the same token cannot silently re-buy the old lines', async () => {
    await fillCart('conv', [[v1, 1]]);
    const first = await placeOrder(details(await intentFor('conv'), 'conv'));
    await expect(fillCart('conv', [[v2, 1]])).rejects.toBeInstanceOf(CartConvertedError);
    expect(await count('orders')).toBe(1);
    expect(first.created).toBe(true);
  });

  it('an expired intent is refused (time is read from Postgres)', async () => {
    await fillCart('exp', [[v1, 1]]);
    const intent = await intentFor('exp');
    await admin.db.execute(
      sql`UPDATE checkout_intents SET expires_at = now() - interval '1 minute' WHERE id = ${intent}`,
    );
    await expect(placeOrder(details(intent, 'exp'))).rejects.toBeInstanceOf(IntentExpiredError);
  });

  it('startCheckout called in parallel returns one intent', async () => {
    await fillCart('par', [[v1, 1]]);
    const barrier = new Barrier(5);
    const views = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const handle = world.connect();
        await handle.db.execute(sql`SELECT 1`);
        await barrier.wait();
        return await handle.db.transaction(
          async (tx) => await startCheckout(tx, { cartToken: tok('par') }),
        );
      }),
    );
    expect(new Set(views.map((v) => v.intentId)).size).toBe(1);
    expect(await count('checkout_intents')).toBe(1);
  });

  it('rejects malformed tokens and unknown variants with domain errors', async () => {
    await expect(
      admin.db.transaction(
        async (tx) => await setCartItem(tx, { cartToken: 'short', variantId: v1, quantity: 1 }),
      ),
    ).rejects.toBeInstanceOf(InvalidCartTokenError);
    await expect(
      admin.db.transaction(
        async (tx) =>
          await setCartItem(tx, {
            cartToken: tok('x'),
            variantId: '00000000-0000-4000-8000-000000000000',
            quantity: 1,
          }),
      ),
    ).rejects.toBeInstanceOf(VariantNotFoundError);
  });
});

describe('failure inside the reservation, and promo restrictions', () => {
  it('lines reserved before a failing line are rolled back even if the caller catches the error', async () => {
    await fillCart('part', [
      [v1, 1],
      [v2, 1],
    ]);
    const intent = await intentFor('part');
    await admin.db.execute(sql`UPDATE product_variants SET is_active = false WHERE id = ${v2}`);

    const handle = world.connect();
    const caught = await handle.db.transaction(async (tx) => {
      try {
        await createOrder(tx, details(intent, 'part'));
        return null;
      } catch (error) {
        return error; // swallowed on purpose: the transaction still commits
      }
    });
    expect(caught).toBeInstanceOf(InsufficientStockError);
    if (!(caught instanceof InsufficientStockError)) throw new Error('unreachable');
    expect(caught.problems).toEqual([{ variantId: v2, requested: 1, available: 0 }]);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });
    expect(await count('orders')).toBe(0);
  });

  it('a deactivated product is not sold', async () => {
    await fillCart('inactive', [[v1, 1]]);
    const intent = await intentFor('inactive');
    await admin.db
      .update(products)
      .set({ isActive: false })
      .where(eq(products.id, world.fixture.productId));
    await expect(placeOrder(details(intent, 'inactive'))).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 0 });
  });

  it('promo codes that need an account are refused for a guest', async () => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value, per_customer_limit) VALUES ('ONEEACH', 'fixed', 100, 1)`,
    );
    await fillCart('guest', [[v1, 1]]);
    await expect(
      placeOrder(details(await intentFor('guest'), 'guest', { promoCode: 'ONEEACH' })),
    ).rejects.toBeInstanceOf(PromoRejectedError);
  });

  it('fractional reservation settings do not break checkout', async () => {
    await admin.db.execute(
      sql`INSERT INTO settings (key, value) VALUES ('reservation_ttl', '{"transfer_hours": 0.3}')`,
    );
    await fillCart('ttl', [[v1, 1]]);
    await placeOrder(details(await intentFor('ttl'), 'ttl', { paymentProvider: 'bank_transfer' }));
    const row = await admin.db.execute<{ m: number }>(
      sql`SELECT round(extract(epoch FROM (expires_at - now())) / 60)::int AS m FROM stock_reservations`,
    );
    expect(row.rows[0]?.m).toBeGreaterThanOrEqual(17);
    expect(row.rows[0]?.m).toBeLessThanOrEqual(18);
  });
});

describe('guards that must hold even when an upstream lock is bypassed', () => {
  it('consumePromoUse refuses a use beyond max_uses', async () => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value, max_uses, uses_count) VALUES ('FULL', 'fixed', 100, 1, 1)`,
    );
    const [row] = (await admin.db.execute<{ id: string }>(sql`SELECT id FROM promo_codes`)).rows;
    await expect(
      admin.db.transaction(async (tx) => {
        await consumePromoUse(tx, row?.id ?? '');
      }),
    ).rejects.toBeInstanceOf(PromoRejectedError);
    const after = await admin.db.execute<{ uses_count: number }>(
      sql`SELECT uses_count FROM promo_codes`,
    );
    expect(after.rows[0]?.uses_count).toBe(1);
  });

  it('reserveStock alone (no acquireLocks) never oversells from two connections', async () => {
    const line: CheckoutLine = {
      variantId: v1,
      productId: world.fixture.productId,
      categoryId: '00000000-0000-4000-8000-000000000000',
      quantity: 1,
      unitPrice: money(129900),
      hasCompareAtPrice: false,
      isSellable: true,
      nameSnapshot: 'x',
      skuSnapshot: 'x',
      brandSnapshot: 'x',
      sizeLabel: 'x',
      sizeSystem: 'x',
      colorName: 'x',
      uktzed: null,
      unitCost: null,
    };
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      await handle.db.transaction(async (tx) => {
        await reserveStock(tx, [line]);
      });
    };
    const results = await settle([run(), run()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await stock(v1)).toEqual({ stock: 1, reserved: 1 });
  });

  it('a new cart token after conversion starts a clean cart (the web layer rotates the token)', async () => {
    await fillCart('old-token', [[v1, 1]]);
    await placeOrder(details(await intentFor('old-token'), 'old-token'));
    await fillCart('new-token', [[v2, 1]]);
    const view = await admin.db.transaction(
      async (tx) => await startCheckout(tx, { cartToken: tok('new-token') }),
    );
    expect(view.orderId).toBeNull();
    await expect(placeOrder(details(view.intentId, 'new-token'))).resolves.toMatchObject({
      created: true,
    });
  });
});
