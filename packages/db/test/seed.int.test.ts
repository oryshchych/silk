/**
 * Seed на реальному Postgres. Перевіряє не «вставилось», а те, що дані
 * проходять ті самі звірки, які робитимуть воркери: інакше перший же
 * `stock:reconcile` на staging підніме тривогу через seed.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../src/client.ts';
import { seed, type SeedSummary } from '../seed/seed.ts';
import { createTestDatabase, type TestDatabase } from './db.ts';

let testDb: TestDatabase;
let handle: DbHandle;
let sqlClient: pg.Client;
let summary: SeedSummary;

async function rows<T extends pg.QueryResultRow>(query: string): Promise<T[]> {
  return (await sqlClient.query<T>(query)).rows;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
  summary = await handle.db.transaction(async (tx) => await seed(tx));
  sqlClient = new pg.Client({ connectionString: testDb.appUrl });
  await sqlClient.connect();
});

afterAll(async () => {
  await sqlClient.end();
  await handle.close();
  await testDb.drop();
});

describe('seed', () => {
  it('створює обсяг зі специфікації фази 0', () => {
    expect(summary).toMatchObject({ products: 40, orders: 15, promoCodes: 5, reviews: 10 });
    expect(summary.variants).toBeGreaterThan(40);
  });

  it('покриває всі статуси замовлення й оплати', async () => {
    const [s] = await rows<{ order: string[]; payment: string[] }>(`
      SELECT array_agg(DISTINCT status::text ORDER BY status::text) AS order,
             array_agg(DISTINCT payment_status::text ORDER BY payment_status::text) AS payment
        FROM orders`);
    expect(s?.order).toEqual([
      'cancelled',
      'confirmed',
      'delivered',
      'pending',
      'processing',
      'returned',
      'shipped',
    ]);
    expect(s?.payment).toEqual([
      'authorized',
      'expired',
      'failed',
      'paid',
      'partially_refunded',
      'pending',
      'refunded',
    ]);
  });

  it('reserved_quantity = сума активних резервів (stock:reconcile, ADR-3)', async () => {
    const mismatches = await rows(`
      SELECT v.id FROM product_variants v
        LEFT JOIN stock_reservations r ON r.variant_id = v.id AND r.released_at IS NULL
       GROUP BY v.id, v.reserved_quantity
      HAVING v.reserved_quantity <> coalesce(sum(r.quantity), 0)`);
    expect(mismatches).toEqual([]);
  });

  it('резерви за ADR-18: активні лише до відправлення', async () => {
    const wrong = await rows(`
      SELECT o.order_number FROM orders o
        JOIN stock_reservations r ON r.order_id = o.id
       WHERE (o.status IN ('shipped', 'delivered', 'returned', 'cancelled') AND r.released_at IS NULL)
          OR (o.status IN ('pending', 'confirmed', 'processing') AND r.released_at IS NOT NULL)
          OR (o.payment_status IN ('paid', 'authorized') AND r.released_at IS NULL
              AND r.expires_at IS NOT NULL)`);
    expect(wrong).toEqual([]);
  });

  it('суми замовлень сходяться з позиціями (orders:reconcile-totals, ADR-15)', async () => {
    const mismatches = await rows(`
      SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id
       GROUP BY o.id, o.subtotal, o.discount_total
      HAVING o.discount_total <> sum(i.line_discount)
          OR o.subtotal <> sum(i.line_total) + sum(i.line_discount)`);
    expect(mismatches).toEqual([]);
  });

  it('captured_total = сума captured успішних спроб; refunded = сума повернень', async () => {
    const mismatches = await rows(`
      SELECT o.order_number FROM orders o
       WHERE o.captured_total <> (SELECT coalesce(sum(captured_amount), 0)
                                    FROM payment_attempts a WHERE a.order_id = o.id)
          OR o.refunded_total <> (SELECT coalesce(sum(amount), 0) FROM refund_operations f
                                   WHERE f.order_id = o.id AND f.state = 'succeeded')`);
    expect(mismatches).toEqual([]);
  });

  it('друга спроба оплати не створює друге замовлення (ADR-11)', async () => {
    const [r] = await rows<{ n: number }>(`
      SELECT count(*)::int AS n FROM (SELECT order_id FROM payment_attempts
                                       GROUP BY order_id HAVING count(*) > 1) x`);
    expect(r?.n).toBe(1);
  });

  it('uses_count промокодів = спожиті погашення', async () => {
    const mismatches = await rows(`
      SELECT p.code FROM promo_codes p
       WHERE p.uses_count <> (SELECT count(*) FROM promo_code_redemptions r
                               WHERE r.promo_code_id = p.id AND r.state = 'consumed')`);
    expect(mismatches).toEqual([]);
  });

  it('агрегати відгуків рахуються лише зі схвалених', async () => {
    const [r] = await rows<{ reviewed: number; approved: number }>(`
      SELECT (SELECT sum(reviews_count)::int FROM products) AS reviewed,
             (SELECT count(*)::int FROM reviews WHERE is_approved) AS approved`);
    expect(r?.reviewed).toBe(r?.approved);
  });

  it('сертифікатів немає (GIFT_CARDS.md §0)', async () => {
    const [r] = await rows<{ n: number }>(`
      SELECT (SELECT count(*) FROM gift_cards)::int
           + (SELECT count(*) FROM products WHERE kind = 'gift_card')::int AS n`);
    expect(r?.n).toBe(0);
  });

  it('пошук працює на seed-даних (тригер search_vector)', async () => {
    const [r] = await rows<{ n: number }>(`
      SELECT count(*)::int AS n FROM products
       WHERE search_vector @@ to_tsquery('ukrainian', 'мереживний')`);
    expect(r?.n).toBeGreaterThan(0);
  });

  it('повторний запуск відмовляє й нічого не змінює', async () => {
    await expect(handle.db.transaction(async (tx) => await seed(tx))).rejects.toThrow(
      /каталог не порожній/,
    );
    const [r] = await rows<{ n: number }>('SELECT count(*)::int AS n FROM products');
    expect(r?.n).toBe(40);
  });

  it('детермінований: друга порожня БД отримує ті самі товари й залишки', async () => {
    const other = await createTestDatabase();
    const otherHandle = createDb(other.appUrl, { max: 1 });
    try {
      await otherHandle.db.transaction(async (tx) => await seed(tx));
      const fingerprint = `
        SELECT string_agg(v.sku || ':' || v.stock_quantity || ':' || p.base_price, ',' ORDER BY v.sku)
          AS f FROM product_variants v JOIN products p ON p.id = v.product_id`;
      const otherClient = new pg.Client({ connectionString: other.appUrl });
      await otherClient.connect();
      const [a] = await rows<{ f: string }>(fingerprint);
      const [b] = (await otherClient.query<{ f: string }>(fingerprint)).rows;
      await otherClient.end();
      expect(b?.f).toBe(a?.f);
    } finally {
      await otherHandle.close();
      await other.drop();
    }
  });
});
