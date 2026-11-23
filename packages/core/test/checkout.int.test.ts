/**
 * Phase 2 on real Postgres: the quote guard (Q12), delivery and its
 * directory, shipping fees, COD guards, reservation TTLs, the expiry worker
 * and the cart merge. Concurrency uses separate pools.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { npSettlements, npWarehouses, productVariants, products, settings } from '@store/db/schema';
import { money } from '@store/shared/money';

import { mergeGuestCart } from '../src/cart/merge.ts';
import { setCartItem, startCheckout } from '../src/cart/cart.ts';
import { getCartView } from '../src/cart/view.ts';
import {
  CodNotAllowedError,
  DeliveryInvalidError,
  PaymentMethodUnavailableError,
  PriceChangedError,
  PromoRejectedError,
  QuoteRequiredError,
} from '../src/errors.ts';
import { createOrder, type CreateOrderInput } from '../src/orders/create-order.ts';
import { findReservedDrift, releaseExpiredOrders } from '../src/orders/expiry.ts';
import { findOrderForTracking, getOrderByAccessToken } from '../src/orders/lookup.ts';
import { quoteCheckout } from '../src/orders/quote.ts';
import { searchSettlements, searchWarehouses } from '../src/shipping/np-directory.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let admin: DbHandle;
let v1: string;
let v2: string;

beforeEach(async () => {
  world = await createWorld();
  admin = world.connect(2);
  [v1, v2] = world.fixture.variantIds;
  // Plenty of stock: these tests are about money and rules, not the last unit.
  await admin.db.update(productVariants).set({ stockQuantity: 100 });
});

afterEach(async () => {
  await world.close();
});

const tok = (name: string): string => `tok-${name}`.padEnd(20, 'x');

const order = (intentId: string, name: string, over: Partial<CreateOrderInput> = {}) =>
  ({
    intentId,
    ownerToken: tok(name),
    contact: { email: 'buyer@example.com', phone: '+380501112233', name: 'Buyer' },
    delivery: { method: 'pickup' },
    paymentProvider: 'bank_transfer',
    promoCode: null,
    locale: 'uk',
    ...over,
  }) satisfies CreateOrderInput;

async function cart(name: string, items: [string, number][] = [[v1, 1]]): Promise<string> {
  for (const [variantId, quantity] of items) {
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, { cartToken: tok(name), variantId, quantity });
    });
  }
  const view = await admin.db.transaction(
    async (tx) => await startCheckout(tx, { cartToken: tok(name) }),
  );
  return view.intentId;
}

const quote = async (
  name: string,
  intentId: string,
  delivery: CreateOrderInput['delivery']['method'] = 'pickup',
  promoCode: string | null = null,
) =>
  await admin.db.transaction(
    async (tx) => await quoteCheckout(tx, { cartToken: tok(name), intentId, delivery, promoCode }),
  );

const place = async (input: CreateOrderInput, handle: DbHandle = world.connect()) =>
  await handle.db.transaction(async (tx) => await createOrder(tx, input));

/**
 * Runs `fn` in a transaction on its own connection and keeps that transaction OPEN until
 * `release()`. A second operation started meanwhile that conflicts on a lock is observably
 * blocked, which proves the protection instead of hoping two calls overlapped.
 */
async function holdTx<T>(
  fn: (tx: Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0]) => Promise<T>,
) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = world.connect().db.transaction(async (tx) => {
    const value = await fn(tx);
    ready();
    await gate;
    return value;
  });
  done.catch(() => {
    ready();
  });
  await started;
  return { release, done };
}

const settle = async (ms = 400): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

async function seedDirectory(): Promise<void> {
  await admin.db.insert(npSettlements).values([
    { ref: 'city-kyiv', nameUk: 'Київ', warehousesCount: 500 },
    { ref: 'city-kyivske', nameUk: 'Київське', warehousesCount: 2 },
    { ref: 'city-lviv', nameUk: 'Львів', warehousesCount: 300 },
  ]);
  await admin.db.insert(npWarehouses).values([
    {
      ref: 'wh-kyiv-1',
      settlementRef: 'city-kyiv',
      number: '1',
      descriptionUk: 'Відділення №1: вул. Центральна, 1',
    },
    {
      ref: 'wh-kyiv-2',
      settlementRef: 'city-kyiv',
      number: '2',
      descriptionUk: 'Відділення №2: вул. Лісова, 5',
    },
    {
      ref: 'wh-kyiv-10',
      settlementRef: 'city-kyiv',
      number: '10',
      descriptionUk: 'Відділення №10: вул. Нова, 7',
    },
    {
      ref: 'wh-kyiv-off',
      settlementRef: 'city-kyiv',
      number: '3',
      descriptionUk: 'Закрите',
      isActive: false,
    },
    {
      ref: 'wh-lviv-1',
      settlementRef: 'city-lviv',
      number: '1',
      descriptionUk: 'Львів, відділення №1',
    },
  ]);
}

describe('the quote guard (Q12)', () => {
  it('refuses with PriceChangedError when a price moves after the total was shown, before reserving', async () => {
    const intent = await cart('q1');
    const shown = await quote('q1', intent);
    expect(shown.pricing.total).toBe(129_900);

    await admin.db.update(products).set({ basePrice: 139_900 });
    await expect(place(order(intent, 'q1'))).rejects.toBeInstanceOf(PriceChangedError);
    const [row] = (
      await admin.db.execute<{ reserved: number; orders: number }>(
        sql`SELECT (SELECT sum(reserved_quantity)::int FROM product_variants) AS reserved,
                   (SELECT count(*)::int FROM orders) AS orders`,
      )
    ).rows;
    expect(row).toEqual({ reserved: 0, orders: 0 });

    // The page re-quotes, the buyer confirms the new number, the order stores the database total.
    const requoted = await quote('q1', intent);
    expect(requoted.pricing.total).toBe(139_900);
    const placed = await place(order(intent, 'q1'));
    const [stored] = await admin.db
      .execute<{ total: number }>(sql`SELECT total FROM orders`)
      .then((r) => r.rows);
    expect(placed.created).toBe(true);
    expect(stored?.total).toBe(139_900);
  });

  it('a client cannot influence the total: the only inputs are ids, and an order without a quote is refused', async () => {
    const intent = await cart('q2');
    await expect(place(order(intent, 'q2'))).rejects.toBeInstanceOf(QuoteRequiredError);
  });

  it('a different delivery after the quote changes the total and is refused', async () => {
    await seedDirectory();
    const intent = await cart('q3');
    await quote('q3', intent, 'pickup');
    await expect(
      place(
        order(intent, 'q3', {
          delivery: {
            method: 'np_warehouse',
            settlementRef: 'city-kyiv',
            warehouseRef: 'wh-kyiv-1',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PriceChangedError);
  });

  it('a quote for a stale intent or a foreign token is refused', async () => {
    const intent = await cart('q4');
    await admin.db.transaction(async (tx) => {
      await setCartItem(tx, { cartToken: tok('q4'), variantId: v2, quantity: 1 });
    });
    await expect(quote('q4', intent)).rejects.toMatchObject({ code: 'CHECKOUT_STALE_CART' });
    await expect(
      admin.db.transaction(
        async (tx) =>
          await quoteCheckout(tx, {
            cartToken: tok('other'),
            intentId: intent,
            delivery: 'pickup',
            promoCode: null,
          }),
      ),
    ).rejects.toMatchObject({ code: 'CHECKOUT_INTENT_NOT_FOUND' });
  });
});

describe('shipping fees', () => {
  const total = async (
    name: string,
    method: CreateOrderInput['delivery']['method'],
    promo: string | null = null,
  ) => (await quote(name, await cart(name), method, promo)).pricing;

  it('charges the flat rate below the threshold, nothing above it or for pickup', async () => {
    const low = await total('s1', 'np_courier');
    // 1299.00 is below the 2000.00 default threshold.
    expect(low.shippingTotal).toBe(12_000);
    expect(low.total).toBe(129_900 + 12_000);
    expect((await total('s2', 'pickup')).shippingTotal).toBe(0);
    await admin.db.update(products).set({ basePrice: 200_000 });
    expect((await total('s3', 'np_courier')).shippingTotal).toBe(0);
    await admin.db.update(products).set({ basePrice: 199_999 });
    expect((await total('s4', 'np_courier')).shippingTotal).toBe(12_000);
  });

  it('the threshold is judged after the discount, and a free_shipping promo waives the fee', async () => {
    await admin.db.update(products).set({ basePrice: 200_000 });
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value) VALUES ('TENOFF', 'percent', 10), ('SHIPFREE', 'free_shipping', 0)`,
    );
    const discounted = await total('s5', 'ukrposhta', 'TENOFF');
    expect(discounted.discountTotal).toBe(20_000);
    expect(discounted.shippingTotal).toBe(5_500);
    await admin.db.update(products).set({ basePrice: 100_000 });
    expect((await total('s6', 'np_courier', 'SHIPFREE')).shippingTotal).toBe(0);
  });

  it('settings override the defaults; a malformed value falls back instead of breaking checkout', async () => {
    await admin.db.insert(settings).values([
      { key: 'shipping_rates', value: { np_courier: 9_900, ukrposhta: 'free' } },
      { key: 'free_shipping_threshold', value: { amount: null } },
    ]);
    const courier = await total('s7', 'np_courier');
    expect(courier.shippingTotal).toBe(9_900);
    expect((await total('s8', 'ukrposhta')).shippingTotal).toBe(5_500);
    await admin.db.update(products).set({ basePrice: 900_000 });
    // The threshold rule is switched off: even a big order pays the fee.
    expect((await total('s9', 'np_courier')).shippingTotal).toBe(9_900);
  });
});

describe('delivery details and the Nova Poshta directory', () => {
  it('stores the snapshot of the chosen city and branch on the order', async () => {
    await seedDirectory();
    const intent = await cart('d1');
    await quote('d1', intent, 'np_warehouse');
    const placed = await place(
      order(intent, 'd1', {
        delivery: { method: 'np_warehouse', settlementRef: 'city-kyiv', warehouseRef: 'wh-kyiv-2' },
      }),
    );
    const [row] = (
      await admin.db.execute<Record<string, string>>(
        sql`SELECT delivery_settlement_name, delivery_warehouse_name, delivery_warehouse_ref, shipping_paid_by FROM orders WHERE id = ${placed.orderId}`,
      )
    ).rows;
    expect(row).toMatchObject({
      delivery_settlement_name: 'Київ',
      delivery_warehouse_name: 'Відділення №2: вул. Лісова, 5',
      delivery_warehouse_ref: 'wh-kyiv-2',
      shipping_paid_by: 'sender',
    });
  });

  it.each([
    [
      'a branch of another city',
      { method: 'np_warehouse', settlementRef: 'city-kyiv', warehouseRef: 'wh-lviv-1' },
    ],
    [
      'an inactive branch',
      { method: 'np_warehouse', settlementRef: 'city-kyiv', warehouseRef: 'wh-kyiv-off' },
    ],
    [
      'an unknown city',
      { method: 'np_warehouse', settlementRef: 'nope', warehouseRef: 'wh-kyiv-1' },
    ],
    ['no branch', { method: 'np_warehouse', settlementRef: 'city-kyiv' }],
    ['a courier without an address', { method: 'np_courier', settlementRef: 'city-kyiv' }],
    [
      'a courier address that is blank',
      { method: 'np_courier', settlementRef: 'city-kyiv', address: '   ' },
    ],
    ['ukrposhta without an address', { method: 'ukrposhta' }],
  ] as const)('refuses %s', async (_label, delivery) => {
    await seedDirectory();
    const intent = await cart('d2');
    await quote('d2', intent, delivery.method);
    await expect(place(order(intent, 'd2', { delivery }))).rejects.toBeInstanceOf(
      DeliveryInvalidError,
    );
    const [n] = (await admin.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM orders`))
      .rows;
    expect(n?.n).toBe(0);
  });

  it('autocompletes from our own tables: prefix first, then size; wildcards are literal', async () => {
    await seedDirectory();
    const names = (await searchSettlements(admin.db, 'київ')).map((s) => s.name);
    expect(names).toEqual(['Київ', 'Київське']);
    expect(await searchSettlements(admin.db, 'к')).toEqual([]);
    expect(await searchSettlements(admin.db, '%%')).toEqual([]);
    expect(await searchSettlements(admin.db, 'x'.repeat(200))).toEqual([]);
    const branches = await searchWarehouses(admin.db, 'city-kyiv', '');
    expect(branches.map((b) => b.number)).toEqual(['1', '2', '10']);
    expect((await searchWarehouses(admin.db, 'city-kyiv', 'Лісова')).map((b) => b.ref)).toEqual([
      'wh-kyiv-2',
    ]);
  });
});

describe('payment methods and the COD guards', () => {
  it('refuses a switched-off method', async () => {
    await admin.db.update(settings).set({ value: { mono: false, cod: true, bank_transfer: true } });
    const intent = await cart('p1');
    await quote('p1', intent);
    await expect(place(order(intent, 'p1', { paymentProvider: 'mono' }))).rejects.toBeInstanceOf(
      PaymentMethodUnavailableError,
    );
  });

  it('refuses COD above the amount cap', async () => {
    await admin.db.insert(settings).values({ key: 'cod_max_amount', value: { amount: 100_000 } });
    const intent = await cart('p2');
    await quote('p2', intent);
    await expect(place(order(intent, 'p2', { paymentProvider: 'cod' }))).rejects.toMatchObject({
      code: 'CHECKOUT_COD_NOT_ALLOWED',
    });
  });

  it('a series of 20 COD orders from one phone stops at the pending limit; other phones are unaffected', async () => {
    let created = 0;
    let blocked = 0;
    for (let i = 0; i < 20; i += 1) {
      const name = `series${String(i)}`;
      const intent = await cart(name);
      await quote(name, intent);
      try {
        await place(order(intent, name, { paymentProvider: 'cod' }));
        created += 1;
      } catch (error) {
        if (!(error instanceof CodNotAllowedError)) throw error;
        blocked += 1;
      }
    }
    expect({ created, blocked }).toEqual({ created: 3, blocked: 17 });

    const intent = await cart('other-phone');
    await quote('other-phone', intent);
    const other = await place(
      order(intent, 'other-phone', {
        paymentProvider: 'cod',
        contact: { email: 'x@example.com', phone: '+380509998877', name: 'Other' },
      }),
    );
    expect(other.created).toBe(true);
  });

  it('the phone advisory lock serialises COD checkouts: the second waits, then sees the first', async () => {
    await admin.db
      .insert(settings)
      .values({ key: 'cod_limits', value: { max_pending_per_phone: 1 } });
    // Different variants: otherwise the variant row lock would serialise the two by itself.
    const [i1, i2] = [await cart('lock1', [[v1, 1]]), await cart('lock2', [[v2, 1]])];
    await quote('lock1', i1);
    await quote('lock2', i2);
    const first = await holdTx(
      async (tx) => await createOrder(tx, order(i1, 'lock1', { paymentProvider: 'cod' })),
    );
    // Without the lock the second count would not see the uncommitted first order and succeed at once.
    const second = place(order(i2, 'lock2', { paymentProvider: 'cod' }), world.connect());
    const outcome = second.then(
      () => 'created',
      (error: unknown) => (error instanceof CodNotAllowedError ? 'refused' : 'other'),
    );
    await settle();
    first.release();
    await first.done;
    expect(await outcome).toBe('refused');
  });

  it('refuses a phone that is not in the canonical +380XXXXXXXXX form (the limit keys on it)', async () => {
    const intent = await cart('ph1');
    await quote('ph1', intent);
    await expect(
      place(
        order(intent, 'ph1', {
          paymentProvider: 'cod',
          contact: { email: 'a@example.com', phone: '0501112233', name: 'A' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CHECKOUT_CONTACT_INVALID' });
  });

  it('reservation lifetime follows the method: card 30 min, transfer 24 h, COD 2 h', async () => {
    const minutes = async (
      provider: CreateOrderInput['paymentProvider'],
      name: string,
    ): Promise<number> => {
      const intent = await cart(name);
      await quote(name, intent);
      const placed = await place(order(intent, name, { paymentProvider: provider }));
      const [row] = (
        await admin.db.execute<{ m: number }>(
          sql`SELECT round(extract(epoch FROM (expires_at - created_at)) / 60)::int AS m
                FROM stock_reservations WHERE order_id = ${placed.orderId}`,
        )
      ).rows;
      return row?.m ?? -1;
    };
    expect(await minutes('mono', 'ttl1')).toBe(30);
    expect(await minutes('bank_transfer', 'ttl2')).toBe(24 * 60);
    expect(await minutes('cod', 'ttl3')).toBe(2 * 60);
  });
});

describe('promo codes at the quote', () => {
  it('reports a refused code with its reason and prices without it', async () => {
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value, is_active) VALUES ('OFF', 'percent', 10, false)`,
    );
    const intent = await cart('pc1');
    const bad = await quote('pc1', intent, 'pickup', 'off');
    expect(bad.promo).toEqual({
      code: 'off',
      accepted: false,
      reason: 'inactive or outside its dates',
    });
    expect(bad.pricing.discountTotal).toBe(0);
    const unknown = await quote('pc1', intent, 'pickup', 'nothing');
    expect(unknown.promo).toMatchObject({ accepted: false, reason: 'unknown code' });
    await expect(place(order(intent, 'pc1', { promoCode: 'off' }))).rejects.toBeInstanceOf(
      PromoRejectedError,
    );
  });

  it('a 100 UAH discount over three 200 UAH lines is exactly 10000 kopiykas and subtotal adds up (ADR-15)', async () => {
    const [size] = (
      await admin.db.execute<{ id: string; color: string }>(
        sql`SELECT (SELECT id FROM sizes LIMIT 1) AS id, (SELECT id FROM colors LIMIT 1) AS color`,
      )
    ).rows;
    const created = await admin.db.execute<{ id: string }>(
      sql`INSERT INTO sizes (system, label, sort_order) VALUES ('apparel', 'L', 3) RETURNING id`,
    );
    const [third] = (
      await admin.db.execute<{ id: string }>(
        sql`INSERT INTO product_variants (product_id, size_id, color_id, sku, stock_quantity)
            VALUES (${world.fixture.productId}, ${created.rows[0]?.id}, ${size?.color}, 'SK-001-3', 50)
            RETURNING id`,
      )
    ).rows;
    await admin.db.update(products).set({ basePrice: 20_000 });
    await admin.db.execute(
      sql`INSERT INTO promo_codes (code, type, value) VALUES ('HUNDRED', 'fixed', 10000)`,
    );
    const intent = await cart('pc2', [
      [v1, 1],
      [v2, 1],
      [third?.id ?? '', 1],
    ]);
    await quote('pc2', intent, 'pickup', 'HUNDRED');
    const placed = await place(order(intent, 'pc2', { promoCode: 'HUNDRED' }));
    const [row] = (
      await admin.db.execute<{
        lines: number;
        sum_items: number;
        subtotal: number;
        discount: number;
      }>(
        sql`SELECT (SELECT sum(line_discount)::int FROM order_items WHERE order_id = o.id) AS lines,
                   (SELECT sum(line_total + line_discount)::int FROM order_items WHERE order_id = o.id) AS sum_items,
                   o.subtotal, o.discount_total AS discount
              FROM orders o WHERE o.id = ${placed.orderId}`,
      )
    ).rows;
    expect(row).toEqual({ lines: 10_000, sum_items: 60_000, subtotal: 60_000, discount: 10_000 });
  });
});

describe('the expiry worker (ADR-3)', () => {
  const place3 = async (name: string, provider: CreateOrderInput['paymentProvider']) => {
    const intent = await cart(name);
    await quote(name, intent);
    return await place(order(intent, name, { paymentProvider: provider }));
  };
  const expireAll = async () =>
    await admin.db.execute(
      sql`UPDATE stock_reservations SET expires_at = now() - interval '1 minute'`,
    );

  it('releases only expired reservations, marks them expired, and the counters match the live sum', async () => {
    const stale = await place3('e1', 'mono');
    const fresh = await place3('e2', 'bank_transfer');
    await admin.db.execute(
      sql`UPDATE stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${stale.orderId}`,
    );
    const result = await releaseExpiredOrders(admin.db);
    expect(result).toEqual({ expired: 1, skipped: 0, failed: 0, failedOrderIds: [] });

    const [released] = (
      await admin.db.execute<{ reason: string; status: string; payment: string }>(
        sql`SELECT r.release_reason AS reason, o.status, o.payment_status AS payment
              FROM stock_reservations r JOIN orders o ON o.id = r.order_id WHERE o.id = ${stale.orderId}`,
      )
    ).rows;
    expect(released).toEqual({ reason: 'expired', status: 'cancelled', payment: 'expired' });
    const [kept] = (
      await admin.db.execute<{ live: number }>(
        sql`SELECT count(*)::int AS live FROM stock_reservations WHERE order_id = ${fresh.orderId} AND released_at IS NULL`,
      )
    ).rows;
    expect(kept?.live).toBe(1);
    expect(await findReservedDrift(admin.db)).toEqual([]);
    // A second run changes nothing.
    expect(await releaseExpiredOrders(admin.db)).toEqual({
      expired: 0,
      skipped: 0,
      failed: 0,
      failedOrderIds: [],
    });
  });

  it('an order paid after the scan is left alone, and a confirmed one is not a candidate', async () => {
    const paid = await place3('e3', 'mono');
    await expireAll();
    // Payment lands between the scan and the cancel: simulate it by marking paid first.
    await admin.db.execute(
      sql`UPDATE orders SET payment_status = 'paid', captured_total = total WHERE id = ${paid.orderId}`,
    );
    expect(await releaseExpiredOrders(admin.db)).toEqual({
      expired: 0,
      skipped: 0,
      failed: 0,
      failedOrderIds: [],
    });
    const [row] = (
      await admin.db.execute<{ status: string }>(
        sql`SELECT status FROM orders WHERE id = ${paid.orderId}`,
      )
    ).rows;
    expect(row?.status).toBe('pending');
    expect(await findReservedDrift(admin.db)).toEqual([]);
  });

  it('a payment racing the worker never ends with a cancelled order that was paid', async () => {
    const racing = await place3('e4', 'mono');
    await expireAll();
    const [a, b] = await Promise.allSettled([
      releaseExpiredOrders(world.connect().db),
      world.connect().db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM orders WHERE id = ${racing.orderId} FOR UPDATE`);
        await tx.execute(
          sql`UPDATE orders SET payment_status = 'paid', captured_total = total WHERE id = ${racing.orderId}`,
        );
      }),
    ]);
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
    const [row] = (
      await admin.db.execute<{ status: string; payment: string }>(
        sql`SELECT status, payment_status AS payment FROM orders WHERE id = ${racing.orderId}`,
      )
    ).rows;
    // Either order of the two is legal; what must never happen is a counter that disagrees.
    expect(await findReservedDrift(admin.db)).toEqual([]);
    expect(row?.payment).toBe('paid');
  });

  it('findReservedDrift reports a counter that does not match', async () => {
    await place3('e5', 'mono');
    await admin.db.execute(
      sql`UPDATE product_variants SET reserved_quantity = reserved_quantity + 2 WHERE id = ${v1}`,
    );
    const drift = await findReservedDrift(admin.db);
    expect(drift).toEqual([{ variantId: v1, counter: 3, liveReservations: 1 }]);
  });
});

describe('merging the guest cart at login', () => {
  it('adds quantities, keeps both carts items, caps a line at 99 and removes the guest cart', async () => {
    await cart('guest', [
      [v1, 2],
      [v2, 5],
    ]);
    await cart('member', [[v1, 98]]);
    const merged = await admin.db.transaction(
      async (tx) =>
        await mergeGuestCart(tx, { guestToken: tok('guest'), customerCartToken: tok('member') }),
    );
    expect(merged).toEqual({ merged: 2 });
    const view = await getCartView(admin.db, tok('member'), 'uk');
    expect(Object.fromEntries(view.lines.map((l) => [l.variantId, l.quantity]))).toEqual({
      [v1]: 99,
      [v2]: 5,
    });
    expect((await getCartView(admin.db, tok('guest'), 'uk')).lines).toEqual([]);
  });

  it('is idempotent and a no-op for an empty or missing guest cart', async () => {
    await cart('member2', [[v1, 1]]);
    const none = await admin.db.transaction(
      async (tx) =>
        await mergeGuestCart(tx, { guestToken: tok('ghost'), customerCartToken: tok('member2') }),
    );
    expect(none).toEqual({ merged: 0 });
    expect((await getCartView(admin.db, tok('member2'), 'uk')).itemCount).toBe(1);
  });

  it('an item added to the guest cart by a transaction still open is not lost by the merge', async () => {
    await cart('gh', [[v1, 1]]);
    await cart('mh', [[v1, 1]]);
    // An open transaction holds the guest cart (and its new line) while the merge starts.
    const holder = await holdTx(async (tx) => {
      await setCartItem(tx, { cartToken: tok('gh'), variantId: v2, quantity: 2 });
    });
    const merge = world
      .connect()
      .db.transaction(
        async (tx) =>
          await mergeGuestCart(tx, { guestToken: tok('gh'), customerCartToken: tok('mh') }),
      );
    await settle();
    holder.release();
    await holder.done;
    expect((await merge).merged).toBe(2);
    const view = await getCartView(admin.db, tok('mh'), 'uk');
    expect(Object.fromEntries(view.lines.map((l) => [l.variantId, l.quantity]))).toEqual({
      [v1]: 2,
      [v2]: 2,
    });
  });

  it('two merges into one cart from separate connections do not deadlock and lose nothing', async () => {
    await cart('g1', [[v1, 1]]);
    await cart('g2', [[v2, 1]]);
    await cart('m', [[v1, 1]]);
    const results = await Promise.all([
      world
        .connect()
        .db.transaction(
          async (tx) =>
            await mergeGuestCart(tx, { guestToken: tok('g1'), customerCartToken: tok('m') }),
        ),
      world
        .connect()
        .db.transaction(
          async (tx) =>
            await mergeGuestCart(tx, { guestToken: tok('g2'), customerCartToken: tok('m') }),
        ),
    ]);
    expect(results.map((r) => r.merged)).toEqual([1, 1]);
    expect((await getCartView(admin.db, tok('m'), 'uk')).itemCount).toBe(3);
  });
});

describe('cart view and order lookup', () => {
  it('shows database prices and live availability, and flags lines that cannot be ordered', async () => {
    await cart('view', [[v1, 3]]);
    await admin.db
      .update(productVariants)
      .set({ stockQuantity: 2, reservedQuantity: 0 })
      .where(eq(productVariants.id, v1));
    const view = await getCartView(admin.db, tok('view'), 'en');
    expect(view.lines[0]).toMatchObject({
      unitPrice: 129_900,
      quantity: 3,
      lineTotal: money(389_700),
      available: 2,
      sellable: true,
    });
    expect(view.hasProblems).toBe(true);
    expect(view.subtotal).toBe(389_700);
    expect(JSON.stringify(view)).not.toMatch(/cost/i);
  });

  it('serves an order by its access token or by number plus phone, and nothing else', async () => {
    const intent = await cart('look');
    await quote('look', intent);
    const placed = await place(order(intent, 'look'));
    const token = placed.accessToken ?? '';
    const byToken = await getOrderByAccessToken(admin.db, placed.orderNumber, token);
    expect(byToken?.orderNumber).toBe(placed.orderNumber);
    expect(Object.keys(byToken ?? {})).not.toContain('adminNote');
    expect(JSON.stringify(byToken)).not.toMatch(/unitCost|ip"/);
    expect(await getOrderByAccessToken(admin.db, placed.orderNumber, `${token}x`)).toBeNull();
    expect(await getOrderByAccessToken(admin.db, 'nonsense', token)).toBeNull();
    expect(
      (await findOrderForTracking(admin.db, placed.orderNumber.toLowerCase(), '+380501112233'))
        ?.total,
    ).toBe(129_900);
    expect(await findOrderForTracking(admin.db, placed.orderNumber, '+380501112234')).toBeNull();
  });
});
