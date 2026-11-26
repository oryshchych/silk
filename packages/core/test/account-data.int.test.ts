/**
 * The customer's own data on real Postgres, always with TWO customers: orders, reorder, addresses,
 * profile, saved sizes and the newsletter choice. Another customer's record answers like a missing
 * one; every write is audited with the account as author; the serialized DTO has no stray keys.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { auditLog, customers, newsletterSubscribers, orders, sizes } from '@store/db/schema';

import {
  AddressLimitError,
  AddressNotFoundError,
  MAX_ADDRESSES,
  addAddress,
  addressInputSchema,
  deleteAddress,
  listMyAddresses,
  updateAddress,
} from '../src/account/addresses.ts';
import { getMyOrder, listMyOrders, reorderMyOrder } from '../src/account/orders.ts';
import {
  SizeNotFoundError,
  getProfile,
  setMySizes,
  setNewsletter,
  updateProfile,
  updateProfileSchema,
} from '../src/account/profile.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';
import { placeOrder } from './place-order.ts';

let world: TestWorld;
let handle: DbHandle;
let a: { customerId: string; userId: string; ip: null };
let b: { customerId: string; userId: string; ip: null };
let orderA: string;
let orderB: string;
let numberA = '';
let numberB = '';

async function customer(email: string) {
  const [user] = await handle.db
    .execute<{ id: string }>(
      sql`INSERT INTO auth_users (email, email_verified_at) VALUES (${email}, now()) RETURNING id`,
    )
    .then((r) => r.rows);
  const [row] = await handle.db
    .insert(customers)
    .values({ email, userId: user?.id ?? null })
    .returning({ id: customers.id });
  return { customerId: row?.id ?? '', userId: user?.id ?? '', ip: null } as const;
}

const ukrposhta = (over: Record<string, unknown> = {}) =>
  addressInputSchema.parse({
    deliveryMethod: 'ukrposhta',
    recipientName: 'Іра Петренко',
    phone: '0501234567',
    street: 'Хрещатик',
    house: '1',
    postcode: '01001',
    ...over,
  });

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(10);
  a = await customer('a@example.test');
  b = await customer('b@example.test');
  orderA = await placeOrder(handle, world.fixture.variantIds[0], 'cod');
  orderB = await placeOrder(handle, world.fixture.variantIds[1], 'cod');
  await handle.db.update(orders).set({ customerId: a.customerId }).where(eq(orders.id, orderA));
  await handle.db.update(orders).set({ customerId: b.customerId }).where(eq(orders.id, orderB));
  numberA =
    (await handle.db.select().from(orders).where(eq(orders.id, orderA)))[0]?.orderNumber ?? '';
  numberB =
    (await handle.db.select().from(orders).where(eq(orders.id, orderB)))[0]?.orderNumber ?? '';
});
afterAll(async () => {
  await world.close();
});

describe('orders: IDOR between two customers', () => {
  it('each customer lists only their own orders', async () => {
    const mineA = await listMyOrders(handle.db, a.customerId);
    const mineB = await listMyOrders(handle.db, b.customerId);
    expect(mineA.map((row) => row.orderNumber)).toEqual([numberA]);
    expect(mineB.map((row) => row.orderNumber)).toEqual([numberB]);
  });

  it('another customer\'s order number is "not found", exactly like a number that does not exist', async () => {
    expect(await getMyOrder(handle.db, a.customerId, numberB)).toBeNull();
    expect(await getMyOrder(handle.db, a.customerId, 'LS-2026-999999')).toBeNull();
    expect(await getMyOrder(handle.db, a.customerId, 'garbage')).toBeNull();
    const own = await getMyOrder(handle.db, a.customerId, numberA.toLowerCase());
    expect(own?.orderNumber).toBe(numberA);
  });

  it('the serialized order carries no cost, no admin note, no ip, no internal ids', async () => {
    await handle.db.execute(sql`UPDATE orders SET admin_note = 'secret-note' WHERE id = ${orderA}`);
    const own = await getMyOrder(handle.db, a.customerId, numberA);
    const text = JSON.stringify(own);
    for (const key of [
      'unitCost',
      'unit_cost',
      'adminNote',
      'secret-note',
      'accessToken',
      'customerId',
      'ip"',
    ]) {
      expect(text).not.toContain(key);
    }
    expect(Object.keys(own?.items[0] ?? {}).sort()).toEqual(
      [
        'colorName',
        'lineDiscount',
        'lineTotal',
        'name',
        'productId',
        'quantity',
        'sizeLabel',
        'sku',
        'unitPrice',
      ].sort(),
    );
  });

  it("reorder uses the cart and the CURRENT state; another customer's order is refused", async () => {
    const token = 'reorder-cart-token-aaaaaaaa';
    const refused = await handle.db.transaction(
      async (tx) =>
        await reorderMyOrder(tx, {
          customerId: a.customerId,
          orderNumber: numberB,
          cartToken: token,
        }),
    );
    expect(refused).toBeNull();
    expect(
      (await handle.db.execute(sql`SELECT 1 FROM carts WHERE token = ${token}`)).rowCount,
    ).toBe(0);
    const done = await handle.db.transaction(
      async (tx) =>
        await reorderMyOrder(tx, {
          customerId: a.customerId,
          orderNumber: numberA,
          cartToken: token,
        }),
    );
    expect(done).toEqual({ added: 1, skipped: 0 });
    await handle.db.execute(
      sql`UPDATE product_variants SET is_active = false WHERE id = ${world.fixture.variantIds[0]}`,
    );
    const again = await handle.db.transaction(
      async (tx) =>
        await reorderMyOrder(tx, {
          customerId: a.customerId,
          orderNumber: numberA,
          cartToken: 'reorder-cart-token-bbbbbbbb',
        }),
    );
    expect(again).toEqual({ added: 0, skipped: 1 });
  });
});

describe('addresses', () => {
  it('rejects bad input before the database: phone, postcode, control characters, unknown method', () => {
    expect(() => ukrposhta({ phone: '123' })).toThrow();
    expect(() => ukrposhta({ postcode: 'abc' })).toThrow();
    expect(() => ukrposhta({ street: 'a\u0000b' })).toThrow();
    expect(() => addressInputSchema.parse({ deliveryMethod: 'pickup' })).toThrow();
    expect(ukrposhta().phone).toMatch(/^\+380/);
  });

  it('IDOR: another customer cannot read, change or delete my address; the answer is "not found"', async () => {
    const id = await handle.db.transaction(async (tx) => await addAddress(tx, a, ukrposhta()));
    await expect(
      handle.db.transaction(async (tx) => {
        await updateAddress(tx, b, id, ukrposhta({ street: 'Hacked' }));
      }),
    ).rejects.toBeInstanceOf(AddressNotFoundError);
    await expect(
      handle.db.transaction(async (tx) => {
        await deleteAddress(tx, b, id);
      }),
    ).rejects.toBeInstanceOf(AddressNotFoundError);
    expect(await listMyAddresses(handle.db, b.customerId)).toEqual([]);
    const mine = await listMyAddresses(handle.db, a.customerId);
    expect(mine[0]?.street).toBe('Хрещатик');
    expect(Object.keys(mine[0] ?? {})).not.toContain('customerId');
  });

  it('the first address is the default and exactly one stays the default; deleting it promotes another', async () => {
    const second = await handle.db.transaction(
      async (tx) => await addAddress(tx, a, ukrposhta({ street: 'Друга' })),
    );
    const third = await handle.db.transaction(
      async (tx) => await addAddress(tx, a, ukrposhta({ street: 'Третя', isDefault: true })),
    );
    let list = await listMyAddresses(handle.db, a.customerId);
    expect(list.filter((row) => row.isDefault).map((row) => row.id)).toEqual([third]);
    await handle.db.transaction(async (tx) => {
      await deleteAddress(tx, a, third);
    });
    list = await listMyAddresses(handle.db, a.customerId);
    expect(list.filter((row) => row.isDefault)).toHaveLength(1);
    expect(list.some((row) => row.id === second)).toBe(true);
  });

  it('an unknown Nova Poshta point is refused (checked against our directory)', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await addAddress(
          tx,
          a,
          addressInputSchema.parse({
            deliveryMethod: 'np_warehouse',
            recipientName: 'X',
            phone: '0501234567',
            settlementRef: 'nope',
            warehouseRef: 'nope',
          }),
        );
      }),
    ).rejects.toThrow();
  });

  it('PARALLEL adds (separate pools) cannot pass the limit of ten', async () => {
    const c = await customer('limit@example.test');
    const barrier = new Barrier(14);
    const parties = Array.from({ length: 14 }, () => world.connect(1));
    const results = await Promise.all(
      parties.map(async (party, i) => {
        await barrier.wait();
        return await party.db
          .transaction(
            async (tx) => await addAddress(tx, c, ukrposhta({ street: `Вулиця ${String(i)}` })),
          )
          .then(
            () => 'ok',
            (error: unknown) => (error instanceof AddressLimitError ? 'limit' : 'other'),
          );
      }),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(MAX_ADDRESSES);
    expect(results.filter((r) => r === 'limit')).toHaveLength(4);
    expect(
      (await listMyAddresses(handle.db, c.customerId)).filter((r) => r.isDefault),
    ).toHaveLength(1);
  });
});

describe('profile, sizes, newsletter', () => {
  it('updates the profile; the audit row names the fields, never the values', async () => {
    await handle.db.transaction(async (tx) => {
      await updateProfile(
        tx,
        a,
        updateProfileSchema.parse({
          firstName: 'Ірина',
          lastName: ' ',
          phone: '050 123 45 67',
          locale: 'en',
        }),
      );
    });
    const profile = await getProfile(handle.db, a.customerId);
    expect(profile).toMatchObject({ firstName: 'Ірина', lastName: null, locale: 'en' });
    expect(profile?.phone).toMatch(/^\+380/);
    const rows = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'customer.profile_updated'));
    expect(JSON.stringify(rows)).not.toContain('Ірина');
    expect(() =>
      updateProfileSchema.parse({ firstName: 'x', lastName: '', phone: '12', locale: 'uk' }),
    ).toThrow();
    expect(() =>
      updateProfileSchema.parse({ firstName: 'x', lastName: '', phone: '', locale: 'de' }),
    ).toThrow();
  });

  it('saves sizes of the right system only; another system or an unknown id is refused', async () => {
    const [bra] = await handle.db
      .insert(sizes)
      .values({ system: 'bra', label: '75B', band: 75, cup: 'B' })
      .returning({ id: sizes.id });
    const [app] = await handle.db
      .insert(sizes)
      .values({ system: 'apparel', label: 'Test-M' })
      .returning({ id: sizes.id });
    await handle.db.transaction(async (tx) => {
      await setMySizes(tx, a, { braSizeId: bra?.id ?? null, apparelSizeId: app?.id ?? null });
    });
    expect(await getProfile(handle.db, a.customerId)).toMatchObject({
      braSizeId: bra?.id,
      apparelSizeId: app?.id,
    });
    await expect(
      handle.db.transaction(async (tx) => {
        await setMySizes(tx, a, { braSizeId: app?.id ?? null, apparelSizeId: null });
      }),
    ).rejects.toBeInstanceOf(SizeNotFoundError);
    // The failed attempt changed nothing; B's sizes were never touched.
    expect(await getProfile(handle.db, a.customerId)).toMatchObject({ braSizeId: bra?.id });
    expect(await getProfile(handle.db, b.customerId)).toMatchObject({ braSizeId: null });
    await handle.db.transaction(async (tx) => {
      await setMySizes(tx, a, { braSizeId: null, apparelSizeId: null });
    });
    expect(await getProfile(handle.db, a.customerId)).toMatchObject({ braSizeId: null });
  });

  it('newsletter: consent is recorded with time and source; a repeat records nothing; unsubscribing is kept', async () => {
    expect(
      await handle.db.transaction(async (tx) => await setNewsletter(tx, a, { subscribe: true })),
    ).toBe(true);
    expect(
      await handle.db.transaction(async (tx) => await setNewsletter(tx, a, { subscribe: true })),
    ).toBe(false);
    const [row] = await handle.db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, 'a@example.test'));
    expect(row).toMatchObject({ source: 'account', unsubscribedAt: null });
    expect(row?.confirmedAt).not.toBeNull();
    expect(
      await handle.db.transaction(async (tx) => await setNewsletter(tx, a, { subscribe: false })),
    ).toBe(true);
    const [after] = await handle.db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, 'a@example.test'));
    expect(after?.unsubscribedAt).not.toBeNull();
    expect((await getProfile(handle.db, a.customerId))?.acceptsMarketing).toBe(false);
    // B's choice is separate.
    expect((await getProfile(handle.db, b.customerId))?.acceptsMarketing).toBe(false);
    const actions = (await handle.db.select().from(auditLog)).map((r) => r.action);
    expect(actions.filter((x) => x === 'customer.newsletter_subscribed')).toHaveLength(1);
    expect(actions).toContain('customer.newsletter_unsubscribed');
  });
});
