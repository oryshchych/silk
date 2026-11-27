/**
 * The abandoned-cart reminder on real Postgres (phase 11, slice B): who is eligible, that a cart is claimed
 * ONCE even by two workers at the same moment (separate connections, a barrier), that an order placed since
 * (or a converted cart, or withdrawn consent) means no mail, and that the unsubscribe link withdraws consent.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import {
  ABANDONED_AFTER_HOURS,
  buildMarketingUnsubscribeToken,
  claimAbandonedCarts,
  readCartReminder,
  unsubscribeMarketingByToken,
} from '../src/marketing/index.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';
import { backdateCart, customerCart, publishSkeleton } from './marketing-fixture.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
let world: TestWorld;
let admin: DbHandle;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  await publishSkeleton(admin);
});
afterEach(async () => {
  await world.close();
});

const claim = async (handle: DbHandle = admin) =>
  await handle.db.transaction(async (tx) => await claimAbandonedCarts(tx));
const queued = async (): Promise<string[]> =>
  (
    await admin.db.execute<{ dedup_key: string }>(
      sql`SELECT dedup_key FROM outbox WHERE topic = 'email.cart-reminder' ORDER BY dedup_key`,
    )
  ).rows.map((row) => row.dedup_key);

describe('who is claimed', () => {
  it('only an idle cart of a consenting customer; each cart once, one outbox row each', async () => {
    const idle = await customerCart(world, admin);
    await customerCart(world, admin);
    const ancient = await customerCart(world, admin);
    const noFlag = await customerCart(world, admin, { marketing: false });
    const noSub = await customerCart(world, admin, { subscribed: false });
    const empty = await customerCart(world, admin, { items: 0 });
    await admin.db.execute(
      sql`INSERT INTO carts (token) VALUES (${'guest-cart-token'.padEnd(32, 'x')})`,
    );
    await backdateCart(world, idle.cartId, ABANDONED_AFTER_HOURS + 1);
    await backdateCart(world, ancient.cartId, 24 * 10);
    for (const spec of [noFlag, noSub, empty]) {
      await backdateCart(world, spec.cartId, ABANDONED_AFTER_HOURS + 1);
    }

    expect(await claim()).toBe(1);
    expect(await queued()).toEqual([`cart-reminder:${idle.cartId}`]);
    // A second run (the next cron tick) finds nothing: the flag is set once and never cleared.
    expect(await claim()).toBe(0);
    expect(await queued()).toHaveLength(1);
  });

  it('a customer who ordered since the cart last changed, or a converted cart, gets nothing', async () => {
    const ordered = await customerCart(world, admin);
    const byEmail = await customerCart(world, admin);
    const converted = await customerCart(world, admin);
    for (const spec of [ordered, byEmail, converted]) {
      await backdateCart(world, spec.cartId, ABANDONED_AFTER_HOURS + 1);
    }
    const order = (customerId: string | null, email: string) =>
      sql`INSERT INTO orders (order_number, customer_id, customer_email, customer_name, customer_phone, delivery_method,
            payment_provider, subtotal, total)
          VALUES (${`T-${email}`.slice(0, 32)}, ${customerId}::uuid, ${email}, 'B', '+380501112233', 'pickup', 'cod', 100, 100)`;
    await admin.db.execute(order(ordered.customerId, ordered.email));
    await admin.db.execute(order(null, byEmail.email));
    await admin.db.execute(
      sql`UPDATE carts SET converted_at = now() WHERE id = ${converted.cartId}::uuid`,
    );
    expect(await claim()).toBe(0);
  });
});

describe('two workers at once', () => {
  it('claim every cart exactly once between them', async () => {
    const carts = [];
    for (let i = 0; i < 8; i += 1) carts.push(await customerCart(world, admin));
    for (const cart of carts) await backdateCart(world, cart.cartId, ABANDONED_AFTER_HOURS + 1);
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await claim(handle);
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a + b).toBe(8);
    expect(await queued()).toHaveLength(8);
    const flagged = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM carts WHERE abandoned_email_sent_at IS NOT NULL`,
    );
    expect(flagged.rows[0]?.n).toBe(8);
  });
});

describe('at send time', () => {
  it('re-checks: an order placed after the claim, withdrawn consent or sold-out goods mean no reminder', async () => {
    const shopper = await customerCart(world, admin);
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    expect(await claim()).toBe(1);
    const due = await readCartReminder(admin.db, shopper.cartId);
    expect(due?.email).toBe(shopper.email);
    expect(due?.items).toHaveLength(1);
    expect(due?.subscriberId).toBe(shopper.subscriberId);

    await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 0`);
    expect(await readCartReminder(admin.db, shopper.cartId)).toBeNull();
    await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 20`);
    expect(await readCartReminder(admin.db, shopper.cartId)).not.toBeNull();

    await admin.db.execute(
      sql`UPDATE customers SET accepts_marketing = false WHERE id = ${shopper.customerId}::uuid`,
    );
    expect(await readCartReminder(admin.db, shopper.cartId)).toBeNull();
    await admin.db.execute(
      sql`UPDATE customers SET accepts_marketing = true WHERE id = ${shopper.customerId}::uuid`,
    );
    await admin.db.execute(
      sql`INSERT INTO orders (order_number, customer_id, customer_email, customer_name, customer_phone, delivery_method,
            payment_provider, subtotal, total)
          VALUES ('T-AFTER', ${shopper.customerId}::uuid, ${shopper.email}, 'B', '+380501112233', 'pickup', 'cod', 100, 100)`,
    );
    expect(await readCartReminder(admin.db, shopper.cartId)).toBeNull();
  });
});

describe('the unsubscribe link', () => {
  it('withdraws consent once, audits once, and a forged or foreign token does nothing', async () => {
    const shopper = await customerCart(world, admin);
    const token = buildMarketingUnsubscribeToken(SECRET, shopper.subscriberId ?? '');
    const run = async (value: string, secret = SECRET) =>
      await admin.db.transaction(
        async (tx) => await unsubscribeMarketingByToken(tx, secret, value),
      );
    expect(await run(`${token}x`)).toBe(false);
    expect(await run('garbage')).toBe(false);
    expect(await run(token, `${SECRET}-other`)).toBe(false);
    const stillOn = await admin.db.execute<{ flag: boolean; active: boolean }>(
      sql`SELECT c.accepts_marketing AS flag, s.unsubscribed_at IS NULL AS active
            FROM customers c JOIN newsletter_subscribers s ON s.email = c.email`,
    );
    expect(stillOn.rows[0]).toEqual({ flag: true, active: true });

    expect(await run(token)).toBe(true);
    expect(await run(token)).toBe(true);
    const off = await admin.db.execute<{ flag: boolean; active: boolean }>(
      sql`SELECT c.accepts_marketing AS flag, s.unsubscribed_at IS NULL AS active
            FROM customers c JOIN newsletter_subscribers s ON s.email = c.email`,
    );
    expect(off.rows[0]).toEqual({ flag: false, active: false });
    const audit = await admin.db.execute<{ n: number; diff: unknown }>(
      sql`SELECT count(*)::int AS n, max(diff::text) AS diff FROM audit_log WHERE action = 'marketing.unsubscribed_by_link'`,
    );
    expect(audit.rows[0]?.n).toBe(1);
    expect(JSON.stringify(audit.rows[0])).not.toContain('example.test');
    // A withdrawn customer's cart is never claimed.
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    expect(await claim()).toBe(0);
  });
});
