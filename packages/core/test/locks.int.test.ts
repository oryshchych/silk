/**
 * Lock protocol on a real Postgres, from separate connections and with a
 * barrier (phase 0.5 criteria 13 and 14). Sharing one pool would run the
 * "parallel" transactions one after another and the test would be green for
 * nothing; the control test below proves the harness CAN see a deadlock.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { carts, orders } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { acquireLocks, LockOrderViolationError } from '../src/locks/acquire-locks.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

let world: TestWorld;
let cartId: string;
let orderId: string;
let v1: string;
let v2: string;

beforeAll(async () => {
  world = await createWorld();
  [v1, v2] = world.fixture.variantIds.toSorted() as [string, string];
  await world.connect().db.transaction(async (tx) => {
    const [cart] = await tx.insert(carts).values({ token: 'locks-test' }).returning();
    const [order] = await tx
      .insert(orders)
      .values({
        orderNumber: sql`next_order_number()`,
        customerEmail: 'a@example.com',
        customerPhone: '+380501112233',
        customerName: 'Test',
        deliveryMethod: 'pickup',
        subtotal: 100,
        total: 100,
      })
      .returning();
    if (cart === undefined || order === undefined) throw new Error('fixture rows missing');
    cartId = cart.id;
    orderId = order.id;
  });
});

afterAll(async () => {
  await world.close();
});

/** Drizzle wraps driver errors; the Postgres code sits on `cause`. */
const isDeadlock = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '40P01') return true;
  return 'cause' in error && isDeadlock(error.cause);
};

const lockVariantNaive = async (tx: Tx, id: string): Promise<void> => {
  await tx.execute(sql`SELECT id FROM product_variants WHERE id = ${id} FOR UPDATE`);
};

describe('lock protocol on real Postgres', () => {
  it('control: opposing order WITHOUT the helper does deadlock (the harness sees it)', async () => {
    const barrier = new Barrier(2);
    const run = async (first: string, second: string): Promise<unknown> => {
      try {
        await world.connect().db.transaction(async (tx) => {
          await lockVariantNaive(tx, first);
          await barrier.wait(); // both hold their first row before asking for the second
          await lockVariantNaive(tx, second);
        });
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const results = await Promise.all([run(v1, v2), run(v2, v1)]);
    expect(results.filter(isDeadlock)).toHaveLength(1);
  });

  it('same rows requested in opposite order through acquireLocks: no deadlock', async () => {
    for (let round = 0; round < 15; round += 1) {
      const barrier = new Barrier(2);
      const run = async (ids: string[]): Promise<void> => {
        await world.connect().db.transaction(async (tx) => {
          await barrier.wait();
          await acquireLocks(tx, { product_variants: ids });
          await new Promise((resolve) => setTimeout(resolve, 20)); // hold so the peer blocks
        });
      };
      await expect(Promise.all([run([v1, v2]), run([v2, v1])])).resolves.toBeDefined();
    }
  });

  it('mixed paths with intersecting locks (checkout / cancel / webhook shapes): no deadlock', async () => {
    const paths: ((tx: Tx) => Promise<unknown>)[] = [
      // checkout: cart, then variants
      async (tx) => await acquireLocks(tx, { carts: [cartId], product_variants: [v2, v1] }),
      // cancel: order, then variants
      async (tx) => await acquireLocks(tx, { orders: [orderId], product_variants: [v1, v2] }),
      // webhook: order, then variants of that order
      async (tx) => await acquireLocks(tx, { product_variants: [v2], orders: [orderId] }),
      // everything at once
      async (tx) =>
        await acquireLocks(tx, { product_variants: [v1], carts: [cartId], orders: [orderId] }),
    ];
    const barrier = new Barrier(paths.length * 3);
    const run = async (path: (tx: Tx) => Promise<unknown>): Promise<void> => {
      await world.connect().db.transaction(async (tx) => {
        await barrier.wait();
        await path(tx);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };
    const all = paths.flatMap((path) => [run(path), run(path), run(path)]);
    await expect(Promise.all(all)).resolves.toBeDefined();
  });

  it('a protocol violation is a deterministic exception, and the rolled-back tx holds no locks', async () => {
    await expect(
      world.connect().db.transaction(async (tx) => {
        await acquireLocks(tx, { product_variants: [v1] });
        await acquireLocks(tx, { orders: [orderId] }); // lower level after a higher one
      }),
    ).rejects.toBeInstanceOf(LockOrderViolationError);

    // After rollback the variant row is free: NOWAIT would fail if it were still locked.
    await expect(
      world.connect().db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM product_variants WHERE id = ${v1} FOR UPDATE NOWAIT`);
      }),
    ).resolves.toBeUndefined();
  });
});
