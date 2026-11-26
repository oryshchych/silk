/**
 * Reviews on real Postgres: only a buyer of THAT product (decided in the database from orders of the
 * session's customer), the size from the order line, one review per product, five a day, pending reviews
 * invisible everywhere (public read, counters, the cached product read), counters and the fit share computed
 * from the approved rows only, moderation under parallel decisions, no personal data in the public view.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { auditLog, customers, orders, products, reviews } from '@store/db/schema';

import { getProductBySlug } from '../src/catalog/product.ts';
import {
  ReviewExistsError,
  ReviewNotAllowedError,
  MAX_REVIEWS_PER_DAY,
  ReviewTooManyError,
  findPurchase,
  listReviewableProducts,
  reviewInputSchema,
  submitReview,
} from '../src/reviews/customer.ts';
import { displayName, listApprovedReviews } from '../src/reviews/read.ts';
import {
  decideReview,
  listReviewsForModeration,
  replyToReview,
} from '../src/reviews/moderation.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';
import { placeOrder } from './place-order.ts';

let world: TestWorld;
let handle: DbHandle;
let productId = '';
let slug = '';
type Who = { customerId: string; userId: string; ip: null };
let a: Who;
let b: Who;
const MODERATOR = '00000000-0000-4000-8000-0000000000aa';

async function customer(email: string, first: string | null, last: string | null): Promise<Who> {
  const [user] = await handle.db
    .execute<{ id: string }>(
      sql`INSERT INTO auth_users (email, email_verified_at) VALUES (${email}, now()) RETURNING id`,
    )
    .then((r) => r.rows);
  const [row] = await handle.db
    .insert(customers)
    .values({ email, userId: user?.id ?? null, firstName: first, lastName: last })
    .returning({ id: customers.id });
  return { customerId: row?.id ?? '', userId: user?.id ?? '', ip: null };
}
const input = (over: Record<string, unknown> = {}) =>
  reviewInputSchema.parse({
    productId,
    rating: 5,
    title: 'Great',
    body: 'Fits well',
    fit: 'true_to_size',
    ...over,
  });
const send = async (who: Who, over: Record<string, unknown> = {}, h: DbHandle = handle) =>
  await h.db.transaction(async (tx) => await submitReview(tx, who, input(over)));
const approve = async (id: string) =>
  await handle.db.transaction(
    async (tx) => await decideReview(tx, MODERATOR, { id, decision: 'approve' }),
  );
const reject = async (id: string) =>
  await handle.db.transaction(
    async (tx) => await decideReview(tx, MODERATOR, { id, decision: 'reject' }),
  );
const counters = async () => {
  const [row] = await handle.db.select().from(products).where(eq(products.id, productId));
  return {
    avg: row?.ratingAvg,
    count: row?.reviewsCount,
    fitTrue: row?.fitTrueCount,
    fitTotal: row?.fitTotalCount,
  };
};

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(10);
  productId = world.fixture.productId;
  await handle.db.execute(
    sql`UPDATE products SET is_active = true, published_at = now() - interval '1 day' WHERE id = ${productId}`,
  );
  await handle.db.execute(sql`UPDATE categories SET is_active = true`);
  const [row] = await handle.db
    .select({ slug: products.slug })
    .from(products)
    .where(eq(products.id, productId));
  slug = row?.slug ?? '';
  a = await customer('a@example.test', 'Iryna', 'Kovalenko');
  b = await customer('b@example.test', null, null);
});
afterAll(async () => {
  await world.close();
});

describe('who may review', () => {
  it('a customer with no order of this product is refused; so is someone with only a pending order', async () => {
    await expect(send(a)).rejects.toBeInstanceOf(ReviewNotAllowedError);
    const order = await placeOrder(handle, world.fixture.variantIds[0], 'cod');
    await handle.db.update(orders).set({ customerId: a.customerId }).where(eq(orders.id, order));
    // A COD order that nobody confirmed or shipped, unpaid: not a purchase yet.
    expect(await findPurchase(handle.db, a.customerId, productId)).toBeNull();
    await expect(send(a)).rejects.toBeInstanceOf(ReviewNotAllowedError);
  });

  it('a shipped (or paid) order of my own makes me a buyer; a cancelled or returned one does not; ANOTHER customer is not', async () => {
    const [mine] = await handle.db.select().from(orders).where(eq(orders.customerId, a.customerId));
    await handle.db.execute(
      sql`UPDATE orders SET status = 'cancelled' WHERE id = ${mine?.id ?? ''}`,
    );
    expect(await findPurchase(handle.db, a.customerId, productId)).toBeNull();
    await handle.db.execute(sql`UPDATE orders SET status = 'shipped' WHERE id = ${mine?.id ?? ''}`);
    const found = await findPurchase(handle.db, a.customerId, productId);
    expect(found?.orderId).toBe(mine?.id);
    // The wall: B has no order, and A's order is not B's, whatever B sends.
    expect(await findPurchase(handle.db, b.customerId, productId)).toBeNull();
    await expect(send(b)).rejects.toBeInstanceOf(ReviewNotAllowedError);
    // A paid order counts too.
    await handle.db.execute(
      sql`UPDATE orders SET status = 'pending', payment_status = 'paid' WHERE id = ${mine?.id ?? ''}`,
    );
    expect(await findPurchase(handle.db, a.customerId, productId)).not.toBeNull();
    await handle.db.execute(sql`UPDATE orders SET status = 'shipped' WHERE id = ${mine?.id ?? ''}`);
  });

  it('the list of reviewable products is mine only and marks what I already reviewed', async () => {
    expect(
      (await listReviewableProducts(handle.db, a.customerId, 'uk')).map((l) => l.productId),
    ).toEqual([productId]);
    expect(await listReviewableProducts(handle.db, b.customerId, 'uk')).toEqual([]);
  });
});

describe('submitting', () => {
  it('stores a PENDING review with the size of the order line, never a size from the request', async () => {
    const id = await send(a, { sizeBought: 'XXL', isApproved: true, customerId: b.customerId });
    const [row] = await handle.db.select().from(reviews).where(eq(reviews.id, id));
    expect(row).toMatchObject({ customerId: a.customerId, isApproved: false, rejectedAt: null });
    expect(row?.sizeBought).not.toBe('XXL');
    expect(row?.orderId).not.toBeNull();
  });

  it('PENDING is invisible: not in the public list, not in the counters, not in the cached product read', async () => {
    expect(await listApprovedReviews(handle.db, productId)).toEqual([]);
    expect(await counters()).toMatchObject({ count: 0, fitTotal: 0 });
    const detail = await getProductBySlug(handle.db, slug, 'uk');
    expect(detail?.reviews).toEqual([]);
    expect(detail?.reviewsCount).toBe(0);
    expect(JSON.stringify(detail)).not.toContain('Fits well');
  });

  it('one review per product: a repeat, and two PARALLEL submits on separate connections, make one', async () => {
    await expect(send(a)).rejects.toBeInstanceOf(ReviewExistsError);
    const order = await placeOrder(handle, world.fixture.variantIds[1], 'cod');
    await handle.db.execute(sql`UPDATE orders SET status = 'delivered' WHERE id = ${order}`);
    const c = await customer('c@example.test', 'Olena', 'Shevchenko');
    await handle.db.update(orders).set({ customerId: c.customerId }).where(eq(orders.id, order));
    const barrier = new Barrier(2);
    const pools = [world.connect(1), world.connect(1)];
    const results = await Promise.all(
      pools.map(async (pool) => {
        await barrier.wait();
        return await send(c, {}, pool).then(
          () => 'ok',
          (e: unknown) => (e instanceof ReviewExistsError ? 'exists' : 'other'),
        );
      }),
    );
    expect(results.sort()).toEqual(['exists', 'ok']);
    expect(
      await handle.db.select().from(reviews).where(eq(reviews.customerId, c.customerId)),
    ).toHaveLength(1);
  });

  it('text is bounded and stripped of control characters; a rating outside 1 to 5 and a bad fit are refused', () => {
    expect(input({ title: 'a\u0000b\u0007c', body: 'x'.repeat(10) }).title).toBe('abc');
    expect(() => input({ body: 'x'.repeat(2001) })).toThrow();
    expect(() => input({ title: 'x'.repeat(121) })).toThrow();
    expect(() => input({ rating: 0 })).toThrow();
    expect(() => input({ rating: 6 })).toThrow();
    expect(() => input({ rating: 4.5 })).toThrow();
    expect(() => input({ fit: 'huge' })).toThrow();
    expect(input({ title: '  ', body: '' })).toMatchObject({ title: null, body: null });
  });

  it('the database refuses an over-long body and a review that is approved and refused at once', async () => {
    const [row] = await handle.db.select().from(reviews).limit(1);
    await expect(
      handle.db.execute(
        sql`UPDATE reviews SET body = ${'x'.repeat(2001)} WHERE id = ${row?.id ?? ''}`,
      ),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(
        sql`UPDATE reviews SET is_approved = true, rejected_at = now() WHERE id = ${row?.id ?? ''}`,
      ),
    ).rejects.toThrow();
  });
});

describe('moderation, counters and what the page shows', () => {
  it('approving makes it visible and recomputes rating and fit from the approved rows', async () => {
    const [mine] = await handle.db
      .select()
      .from(reviews)
      .where(eq(reviews.customerId, a.customerId));
    const done = await approve(mine?.id ?? '');
    expect(done).toMatchObject({ changed: true, from: 'pending', to: 'approved' });
    expect(await counters()).toMatchObject({ avg: 5, count: 1, fitTrue: 1, fitTotal: 1 });
    const listed = await listApprovedReviews(handle.db, productId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.author).toBe('Iryna K.');
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      'adminReply',
      'author',
      'body',
      'createdAt',
      'fit',
      'rating',
      'sizeBought',
      'title',
    ]);
    const detail = await getProductBySlug(handle.db, slug, 'uk');
    expect(detail?.reviewsCount).toBe(1);
    expect(detail?.fit).toEqual({ truePercent: 100, total: 1 });
    expect(JSON.stringify(detail)).not.toContain('a@example.test');
  });

  it('fit share and average come from REAL rows: a second approved review changes them, a refused one does not', async () => {
    const c = await handle.db.select().from(customers).where(eq(customers.email, 'c@example.test'));
    const [theirs] = await handle.db
      .select()
      .from(reviews)
      .where(eq(reviews.customerId, c[0]?.id ?? ''));
    await handle.db.execute(
      sql`UPDATE reviews SET rating = 2, fit_feedback = 'small' WHERE id = ${theirs?.id ?? ''}`,
    );
    await approve(theirs?.id ?? '');
    expect(await counters()).toMatchObject({ avg: 3.5, count: 2, fitTrue: 1, fitTotal: 2 });
    expect((await getProductBySlug(handle.db, slug, 'uk'))?.fit).toEqual({
      truePercent: 50,
      total: 2,
    });
    await reject(theirs?.id ?? '');
    expect(await counters()).toMatchObject({ avg: 5, count: 1, fitTrue: 1, fitTotal: 1 });
    expect(await listApprovedReviews(handle.db, productId)).toHaveLength(1);
  });

  it('a refused review stays (the buyer cannot resubmit) and is listed as refused; a repeat decision changes nothing', async () => {
    const c = await handle.db.select().from(customers).where(eq(customers.email, 'c@example.test'));
    const [theirs] = await handle.db
      .select()
      .from(reviews)
      .where(eq(reviews.customerId, c[0]?.id ?? ''));
    expect(theirs?.rejectedAt).not.toBeNull();
    expect(await reject(theirs?.id ?? '')).toMatchObject({ changed: false });
    expect((await listReviewsForModeration(handle.db, 'rejected')).map((r) => r.id)).toContain(
      theirs?.id,
    );
    expect((await listReviewsForModeration(handle.db, 'pending')).map((r) => r.id)).not.toContain(
      theirs?.id,
    );
    await expect(send({ customerId: c[0]?.id ?? '', userId: '', ip: null })).rejects.toBeInstanceOf(
      ReviewExistsError,
    );
  });

  it('PARALLEL moderators deciding one review leave the counters consistent', async () => {
    const d = await customer('d@example.test', 'Dana', null);
    const order = await placeOrder(handle, world.fixture.variantIds[0], 'cod');
    await handle.db.execute(sql`UPDATE orders SET status = 'delivered' WHERE id = ${order}`);
    await handle.db.update(orders).set({ customerId: d.customerId }).where(eq(orders.id, order));
    const id = await send(d, { rating: 1, fit: 'large' });
    const barrier = new Barrier(4);
    const pools = Array.from({ length: 4 }, () => world.connect(1));
    await Promise.all(
      pools.map(async (pool, i) => {
        await barrier.wait();
        await pool.db.transaction(
          async (tx) =>
            await decideReview(tx, MODERATOR, { id, decision: i % 2 === 0 ? 'approve' : 'reject' }),
        );
      }),
    );
    const [row] = await handle.db.select().from(reviews).where(eq(reviews.id, id));
    const approvedRows = await handle.db
      .select()
      .from(reviews)
      .where(sql`${reviews.productId} = ${productId} AND ${reviews.isApproved}`);
    expect((await counters()).count).toBe(approvedRows.length);
    expect(Boolean(row?.isApproved) !== (row?.rejectedAt !== null)).toBe(true);
  });

  it('a reply is shown with the review; the audit rows name actions, never the text', async () => {
    const [mine] = await handle.db
      .select()
      .from(reviews)
      .where(eq(reviews.customerId, a.customerId));
    await handle.db.transaction(
      async (tx) =>
        await replyToReview(tx, MODERATOR, {
          id: mine?.id ?? '',
          reply: 'Thank you <b>so</b> much',
        }),
    );
    const shown = (await listApprovedReviews(handle.db, productId)).find(
      (r) => r.author === 'Iryna K.',
    );
    expect(shown?.adminReply).toBe('Thank you <b>so</b> much');
    const text = JSON.stringify(await handle.db.select().from(auditLog));
    expect(text).not.toContain('Fits well');
    expect(text).not.toContain('a@example.test');
  });

  it('the per-day cap refuses the next review (cap 1 here; the real one is five)', async () => {
    const [mine] = await handle.db
      .select()
      .from(customers)
      .where(eq(customers.email, 'd@example.test'));
    await expect(
      handle.db.transaction(
        async (tx) =>
          await submitReview(tx, { customerId: mine?.id ?? '', userId: '', ip: null }, input(), 1),
      ),
    ).rejects.toBeInstanceOf(ReviewTooManyError);
    expect(MAX_REVIEWS_PER_DAY).toBe(5);
  });

  it('the display name never exposes the surname or an address', () => {
    expect(displayName('Iryna', 'Kovalenko')).toBe('Iryna K.');
    expect(displayName('  Iryna  ', null)).toBe('Iryna');
    expect(displayName(null, 'Kovalenko')).toBeNull();
    expect(displayName('Ірина', 'ґанзі')).toBe('Ірина Ґ.');
  });
});
