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
  type ClaimedCart,
  CUSTOMER_REMINDER_CAP_DAYS,
  unsubscribeMarketingByToken,
} from '../src/marketing/index.ts';
import { acquireLocks } from '../src/locks/acquire-locks.ts';
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

/** What the claim recorded for a cart (the send-time check compares against it). */
const claimedOf = async (cartId: string): Promise<ClaimedCart> => {
  const rows = await admin.db.execute<{ payload: ClaimedCart }>(
    sql`SELECT payload FROM outbox WHERE dedup_key = ${`cart-reminder:${cartId}`}`,
  );
  const payload = rows.rows[0]?.payload;
  if (payload === undefined) throw new Error('the cart was not claimed');
  return payload;
};
const reminderFor = async (cartId: string) =>
  await readCartReminder(admin.db, await claimedOf(cartId));

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
    const carts: Awaited<ReturnType<typeof customerCart>>[] = [];
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
    const due = await reminderFor(shopper.cartId);
    expect(due?.email).toBe(shopper.email);
    expect(due?.items).toHaveLength(1);
    expect(due?.subscriberId).toBe(shopper.subscriberId);

    await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 0`);
    expect(await reminderFor(shopper.cartId)).toBeNull();
    await admin.db.execute(sql`UPDATE product_variants SET stock_quantity = 20`);
    expect(await reminderFor(shopper.cartId)).not.toBeNull();

    await admin.db.execute(
      sql`UPDATE customers SET accepts_marketing = false WHERE id = ${shopper.customerId}::uuid`,
    );
    expect(await reminderFor(shopper.cartId)).toBeNull();
    await admin.db.execute(
      sql`UPDATE customers SET accepts_marketing = true WHERE id = ${shopper.customerId}::uuid`,
    );
    await admin.db.execute(
      sql`INSERT INTO orders (order_number, customer_id, customer_email, customer_name, customer_phone, delivery_method,
            payment_provider, subtotal, total)
          VALUES ('T-AFTER', ${shopper.customerId}::uuid, ${shopper.email}, 'B', '+380501112233', 'pickup', 'cod', 100, 100)`,
    );
    expect(await reminderFor(shopper.cartId)).toBeNull();
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

const orderRow = (customerId: string, email: string, number: string) =>
  sql`INSERT INTO orders (order_number, customer_id, customer_email, customer_name, customer_phone, delivery_method,
        payment_provider, subtotal, total)
      VALUES (${number}, ${customerId}::uuid, ${email}, 'B', '+380501112233', 'pickup', 'cod', 100, 100)`;

describe('review round: stable facts at send time', () => {
  it('an order that was in flight during the claim and committed after it still stops the mail', async () => {
    const shopper = await customerCart(world, admin);
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    const other = world.connect();
    const held = other.db.transaction(async (tx) => {
      await tx.execute(orderRow(shopper.customerId, shopper.email, 'T-INFLIGHT'));
      // The claim runs while this order is uncommitted: it cannot see it.
      await inFlight.opened;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await claim()).toBe(1);
    release();
    await held;
    expect(await reminderFor(shopper.cartId)).toBeNull();
  });

  it('a cart edited after the claim, or a claim older than the send window, sends nothing', async () => {
    const edited = await customerCart(world, admin);
    const stale = await customerCart(world, admin);
    for (const cart of [edited, stale])
      await backdateCart(world, cart.cartId, ABANDONED_AFTER_HOURS + 1);
    expect(await claim()).toBe(2);
    expect(await reminderFor(edited.cartId)).not.toBeNull();
    await admin.db.execute(
      sql`UPDATE cart_items SET quantity = 3 WHERE cart_id = ${edited.cartId}::uuid`,
    );
    expect(await reminderFor(edited.cartId)).toBeNull();
    expect(await reminderFor(stale.cartId)).not.toBeNull();
    await admin.db.execute(
      sql`UPDATE carts SET abandoned_email_sent_at = now() - interval '25 hours' WHERE id = ${stale.cartId}::uuid`,
    );
    expect(await reminderFor(stale.cartId)).toBeNull();
  });

  it('a converted cart sends nothing even when the claim already happened', async () => {
    const shopper = await customerCart(world, admin);
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    expect(await claim()).toBe(1);
    const order = await admin.db.execute<{ id: string }>(
      sql`${orderRow(shopper.customerId, shopper.email, 'T-CONV')} RETURNING id`,
    );
    // Only the cart's own conversion fields (the order is older than the activity guard would see).
    await admin.db.execute(
      sql`UPDATE orders SET created_at = now() - interval '30 days' WHERE id = ${order.rows[0]?.id ?? ''}::uuid`,
    );
    await admin.db.execute(
      sql`UPDATE carts SET converted_at = now(), converted_order_id = ${order.rows[0]?.id ?? ''}::uuid WHERE id = ${shopper.cartId}::uuid`,
    );
    expect(await reminderFor(shopper.cartId)).toBeNull();
    // converted_order_id alone, converted_at alone: each stops it.
    await admin.db.execute(
      sql`UPDATE carts SET converted_at = NULL WHERE id = ${shopper.cartId}::uuid`,
    );
    expect(await reminderFor(shopper.cartId)).toBeNull();
    await admin.db.execute(
      sql`UPDATE carts SET converted_at = now(), converted_order_id = NULL WHERE id = ${shopper.cartId}::uuid`,
    );
    expect(await reminderFor(shopper.cartId)).toBeNull();
  });

  it('the quantity shown never exceeds what is in stock', async () => {
    const shopper = await customerCart(world, admin);
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    await admin.db.execute(
      sql`UPDATE cart_items SET quantity = 5 WHERE cart_id = ${shopper.cartId}::uuid`,
    );
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    await admin.db.execute(
      sql`UPDATE product_variants SET stock_quantity = 2, reserved_quantity = 1`,
    );
    expect(await claim()).toBe(1);
    expect((await reminderFor(shopper.cartId))?.items[0]?.quantity).toBe(1);
  });
});

describe('review round: one mail per customer, held carts, dedup', () => {
  it('two carts of one customer give one mail, and a recent reminder blocks the next cart for a week', async () => {
    const first = await customerCart(world, admin, { email: 'twice@example.test' });
    const customerId = first.customerId;
    const second = await admin.db.execute<{ id: string }>(
      sql`INSERT INTO carts (token, customer_id) VALUES (${'second-cart-token'.padEnd(32, 'x')}, ${customerId}::uuid) RETURNING id`,
    );
    await admin.db.execute(
      sql`INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES (${second.rows[0]?.id ?? ''}::uuid, ${world.fixture.variantIds[0]}::uuid, 1)`,
    );
    await backdateCart(world, first.cartId, ABANDONED_AFTER_HOURS + 1);
    await backdateCart(world, second.rows[0]?.id ?? '', ABANDONED_AFTER_HOURS + 2);
    expect(await claim()).toBe(1);
    // The NEWEST activity wins.
    expect(await queued()).toEqual([`cart-reminder:${first.cartId}`]);
    expect(await claim()).toBe(0);
    expect(CUSTOMER_REMINDER_CAP_DAYS).toBe(7);
    // A reminder 8 days ago no longer blocks (the cap is a window, not forever).
    await admin.db.execute(
      sql`UPDATE carts SET abandoned_email_sent_at = now() - interval '8 days' WHERE id = ${first.cartId}::uuid`,
    );
    expect(await claim()).toBe(1);
  });

  it('two workers at once do not mail one customer twice through two carts', async () => {
    const first = await customerCart(world, admin, { email: 'race2@example.test' });
    const second = await admin.db.execute<{ id: string }>(
      sql`INSERT INTO carts (token, customer_id) VALUES (${'race-cart-token'.padEnd(32, 'x')}, ${first.customerId}::uuid) RETURNING id`,
    );
    await admin.db.execute(
      sql`INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES (${second.rows[0]?.id ?? ''}::uuid, ${world.fixture.variantIds[0]}::uuid, 1)`,
    );
    for (const id of [first.cartId, second.rows[0]?.id ?? ''])
      await backdateCart(world, id, ABANDONED_AFTER_HOURS + 1);
    const barrier = new Barrier(2);
    const run = async () => {
      const handle = world.connect();
      await handle.db.execute(sql`SELECT 1`);
      await barrier.wait();
      return await claim(handle);
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a + b).toBe(1);
    expect(await queued()).toHaveLength(1);
  });

  it('a cart held by an open checkout does not delay the others and is claimed on a later run', async () => {
    const carts: Awaited<ReturnType<typeof customerCart>>[] = [];
    for (let i = 0; i < 4; i += 1) carts.push(await customerCart(world, admin));
    for (const cart of carts) await backdateCart(world, cart.cartId, ABANDONED_AFTER_HOURS + 1);
    const holder = world.connect();
    const held = gate();
    const locked = gate();
    const checkout = holder.db.transaction(async (tx) => {
      await acquireLocks(tx, { carts: [carts[0]?.cartId ?? ''] });
      locked.open();
      await held.opened;
    });
    await locked.opened;
    const started = Date.now();
    expect(await claim()).toBe(3);
    expect(Date.now() - started).toBeLessThan(2_000);
    held.open();
    await checkout;
    expect(await claim()).toBe(1);
    expect(await queued()).toHaveLength(4);
  });

  it('a checkout that converts the cart while it is locked keeps it out of the claim', async () => {
    const shopper = await customerCart(world, admin);
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    const holder = world.connect();
    const held = gate();
    const locked = gate();
    const checkout = holder.db.transaction(async (tx) => {
      await acquireLocks(tx, { carts: [shopper.cartId] });
      await tx.execute(
        sql`UPDATE carts SET converted_at = now() WHERE id = ${shopper.cartId}::uuid`,
      );
      locked.open();
      await held.opened;
    });
    await locked.opened;
    expect(await claim()).toBe(0);
    held.open();
    await checkout;
    // The conversion bumped `updated_at` (touch trigger), which alone would hide the cart: age it again so
    // only the converted fields keep it out.
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    expect(await claim()).toBe(0);
    expect(await queued()).toEqual([]);
  });

  it('claims are serialised by one advisory lock, so the per-customer cap cannot be raced', async () => {
    const shopper = await customerCart(world, admin);
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    const holder = world.connect();
    const held = gate();
    const locked = gate();
    const other = holder.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('carts:remind-claim', 0))`,
      );
      locked.open();
      await held.opened;
    });
    await locked.opened;
    const pending = claim(world.connect());
    const early = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolve(false);
        }, 500),
      ),
    ]);
    held.open();
    await other;
    expect(early).toBe(false);
    expect(await pending).toBe(1);
  });

  it('an outbox row with the same dedup key already there is not an error and not a second row', async () => {
    const shopper = await customerCart(world, admin);
    await backdateCart(world, shopper.cartId, ABANDONED_AFTER_HOURS + 1);
    await admin.db.execute(
      sql`INSERT INTO outbox (topic, payload, dedup_key) VALUES ('email.cart-reminder', '{}'::jsonb, ${`cart-reminder:${shopper.cartId}`})`,
    );
    expect(await claim()).toBe(1);
    expect(await queued()).toHaveLength(1);
  });
});

/** A promise that settles when `open()` is called. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}
const inFlight = gate();
const release = inFlight.open;
