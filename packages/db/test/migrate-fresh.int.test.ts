/**
 * migrate:fresh — порожня БД + усі міграції, включно з ручними.
 *
 * Самі міграції застосовує globalSetup (pg-container.ts): якщо будь-яка
 * падає, прогін не доходить до цього файла. Тут перевіряється, що ручний
 * SQL не лише виконався, а й ПРАЦЮЄ — бо «міграція пройшла» і «тригер
 * заповнює вектор» — різні твердження (REVIEW_TRIAGE, «написано, але не
 * підключено»).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder } from '../src/migrate.ts';

interface Journal {
  entries: { tag: string }[];
}

const FK_VIOLATION = '23503';

let root: pg.Client;
let migrator: pg.Client;
let app: pg.Client;

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function one<T extends pg.QueryResultRow>(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const { rows } = await client.query<T>(sql, params);
  const [row] = rows;
  if (row === undefined) throw new Error(`порожній результат: ${sql}`);
  return row;
}

beforeAll(async () => {
  root = await connect(inject('pgRootUrl'));
  migrator = await connect(inject('pgMigrateUrl'));
  app = await connect(inject('pgAppUrl'));
});

afterAll(async () => {
  await Promise.all([root.end(), migrator.end(), app.end()]);
});

describe('журнал міграцій', () => {
  it('застосовано всі міграції з журналу, 0000_extensions — першою', async () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    const tags = journal.entries.map((e) => e.tag);
    expect(tags[0]).toBe('0000_extensions');
    expect(tags[1]).toBe('0001_schema');

    const { count } = await one<{ count: string }>(
      root,
      'SELECT count(*) FROM drizzle.__drizzle_migrations',
    );
    expect(Number(count)).toBe(tags.length);
  });

  it('усі обʼєкти public належать store_migrate (інакше store_app їх не бачить)', async () => {
    const { rows } = await root.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) <> 'store_migrate'`);
    expect(rows).toEqual([]);
  });
});

describe('0000_extensions', () => {
  it('встановлені pg_trgm, unaccent, btree_gin, pgcrypto', async () => {
    const { rows } = await root.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`,
    );
    expect(rows.map((r) => r.extname)).toEqual(['btree_gin', 'pg_trgm', 'pgcrypto', 'unaccent']);
  });
});

describe('ICU uk-UA', () => {
  it('сортування г ґ е є и і ї', async () => {
    const { ordered } = await one<{ ordered: string }>(
      app,
      `SELECT string_agg(l, ' ' ORDER BY l) AS ordered
         FROM unnest(ARRAY['ї','і','и','є','е','ґ','г']) l`,
    );
    expect(ordered).toBe('г ґ е є и і ї');
  });
});

describe('0002_numbering — greatest(), а не обрізання lpad()', () => {
  const year = new Date().getUTCFullYear();

  it('номер замовлення на межі 999999 / 1000000', async () => {
    await migrator.query(`SELECT setval('order_number_seq', 999998)`);
    const a = await one<{ n: string }>(app, 'SELECT next_order_number() AS n');
    const b = await one<{ n: string }>(app, 'SELECT next_order_number() AS n');
    expect(a.n).toBe(`LS-${String(year)}-999999`);
    expect(b.n).toBe(`LS-${String(year)}-1000000`);
  });

  it('номер повернення на межі 99999 / 100000', async () => {
    await migrator.query(`SELECT setval('return_request_seq', 99998)`);
    const a = await one<{ n: string }>(app, 'SELECT next_return_number() AS n');
    const b = await one<{ n: string }>(app, 'SELECT next_return_number() AS n');
    expect(a.n).toBe(`RET-${String(year)}-99999`);
    expect(b.n).toBe(`RET-${String(year)}-100000`);
  });

  it('малі номери доповнюються нулями', async () => {
    await migrator.query(`SELECT setval('order_number_seq', 41)`);
    const { n } = await one<{ n: string }>(app, 'SELECT next_order_number() AS n');
    expect(n).toBe(`LS-${String(year)}-000042`);
  });
});

describe('0003_search', () => {
  let productId: string;

  beforeAll(async () => {
    const cat = await one<{ id: string }>(
      app,
      `INSERT INTO categories (slug, name_uk, name_en)
       VALUES ('bras', 'Бюстгальтери', 'Bras') RETURNING id`,
    );
    const p = await one<{ id: string }>(
      app,
      `INSERT INTO products (sku, slug, brand, category_id, name_uk, name_en,
                             base_price, weight_grams)
       VALUES ('LS-001', 'lace-set', 'Lauma', $1, 'Мереживні трусики', 'Lace briefs',
               129900, 80)
       RETURNING id`,
      [cat.id],
    );
    productId = p.id;
  });

  it('тригер заповнює search_vector українським hunspell (мереживні → мереживний)', async () => {
    const { hit } = await one<{ hit: boolean }>(
      app,
      `SELECT search_vector @@ to_tsquery('ukrainian', 'мереживний') AS hit
         FROM products WHERE id = $1`,
      [productId],
    );
    expect(hit).toBe(true);
  });

  it('backfill: SET updated_at не запускає тригер, SET name_uk — запускає', async () => {
    // Імітуємо товар, що існував до тригера: вектор порожній.
    await migrator.query('ALTER TABLE products DISABLE TRIGGER products_search_vector_trg');
    await migrator.query('UPDATE products SET search_vector = NULL WHERE id = $1', [productId]);
    await migrator.query('ALTER TABLE products ENABLE TRIGGER products_search_vector_trg');

    await app.query('UPDATE products SET updated_at = updated_at WHERE id = $1', [productId]);
    const before = await one<{ empty: boolean }>(
      app,
      'SELECT search_vector IS NULL AS empty FROM products WHERE id = $1',
      [productId],
    );
    expect(before.empty).toBe(true);

    await app.query('UPDATE products SET name_uk = name_uk WHERE id = $1', [productId]);
    const after = await one<{ empty: boolean }>(
      app,
      'SELECT search_vector IS NULL AS empty FROM products WHERE id = $1',
      [productId],
    );
    expect(after.empty).toBe(false);
  });

  it('search_norm — STORED (у PG 18 дефолт VIRTUAL, який не індексується)', async () => {
    const { attgenerated } = await one<{ attgenerated: string }>(
      root,
      `SELECT attgenerated FROM pg_attribute
        WHERE attrelid = 'products'::regclass AND attname = 'search_norm'`,
    );
    expect(attgenerated).toBe('s');

    const { norm } = await one<{ norm: string }>(
      app,
      'SELECT search_norm AS norm FROM products WHERE id = $1',
      [productId],
    );
    expect(norm).toBe('мереживні трусики lace briefs lauma ls-001');
  });

  it('trigram-індекс стоїть саме на search_norm', async () => {
    const { def } = await one<{ def: string }>(
      root,
      `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'products_search_norm_trgm_idx'`,
    );
    expect(def).toContain('gin (search_norm gin_trgm_ops)');
  });
});

describe('0004_integrity — складені FK', () => {
  const ids = { orderA: '', orderB: '', itemB: '', returnA: '', saleA: '', saleB: '', refundB: '' };

  async function insertOrder(email: string): Promise<string> {
    const { id } = await one<{ id: string }>(
      app,
      `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name,
                           delivery_method, subtotal, total)
       VALUES (next_order_number(), $1, '+380000000000', 'Тест', 'np_warehouse', 10000, 10000)
       RETURNING id`,
      [email],
    );
    return id;
  }

  async function expectFkViolation(sql: string, params: unknown[]): Promise<void> {
    await expect(app.query(sql, params)).rejects.toMatchObject({ code: FK_VIOLATION });
  }

  beforeAll(async () => {
    ids.orderA = await insertOrder('a@example.com');
    ids.orderB = await insertOrder('b@example.com');

    ids.itemB = (
      await one<{ id: string }>(
        app,
        `INSERT INTO order_items (order_id, product_uid_snapshot, variant_uid_snapshot,
                                  name_snapshot, sku_snapshot, size_label, color_name,
                                  unit_price, quantity, line_total)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'Трусики', 'LS-001', 'M',
                 'Чорний', 10000, 1, 10000)
         RETURNING id`,
        [ids.orderB],
      )
    ).id;

    ids.returnA = (
      await one<{ id: string }>(
        app,
        `INSERT INTO return_requests (request_number, order_id, reason, policy_version)
         VALUES (next_return_number(), $1, 'wrong_size', 'v1') RETURNING id`,
        [ids.orderA],
      )
    ).id;

    const sale = `INSERT INTO fiscal_documents (order_id, kind, amount)
                  VALUES ($1, 'sale', 10000) RETURNING id`;
    ids.saleA = (await one<{ id: string }>(app, sale, [ids.orderA])).id;
    ids.saleB = (await one<{ id: string }>(app, sale, [ids.orderB])).id;

    ids.refundB = (
      await one<{ id: string }>(
        app,
        `INSERT INTO refund_operations (order_id, amount) VALUES ($1, 5000) RETURNING id`,
        [ids.orderB],
      )
    ).id;
  });

  it('позиція чужого замовлення в запиті на повернення відкидається', async () => {
    // Запит A, позиція B, order_id = A: простий FK на order_items пройшов би.
    await expectFkViolation(
      `INSERT INTO return_request_items (return_request_id, order_item_id, order_id, quantity)
       VALUES ($1, $2, $3, 1)`,
      [ids.returnA, ids.itemB, ids.orderA],
    );
    // order_id = B: тепер не сходиться запит.
    await expectFkViolation(
      `INSERT INTO return_request_items (return_request_id, order_item_id, order_id, quantity)
       VALUES ($1, $2, $3, 1)`,
      [ids.returnA, ids.itemB, ids.orderB],
    );
  });

  it('чек повернення не посилається на чек продажу чужого замовлення', async () => {
    // Since 0014 a return names its refund; one of order A's own keeps the parent link the only fault.
    const { id: refundA } = await one<{ id: string }>(
      app,
      `INSERT INTO refund_operations (order_id, amount) VALUES ($1, 50) RETURNING id`,
      [ids.orderA],
    );
    await expectFkViolation(
      `INSERT INTO fiscal_documents (order_id, kind, amount, parent_document_id, refund_operation_id)
       VALUES ($1, 'return', 5000, $2, $3)`,
      [ids.orderA, ids.saleB, refundA],
    );
  });

  it('чек не посилається на операцію повернення чужого замовлення', async () => {
    await expectFkViolation(
      `INSERT INTO fiscal_documents (order_id, kind, amount, parent_document_id, refund_operation_id)
       VALUES ($1, 'return', 5000, $2, $3)`,
      [ids.orderA, ids.saleA, ids.refundB],
    );
  });

  it('коректний чек повернення того самого замовлення приймається', async () => {
    await app.query(
      `INSERT INTO fiscal_documents (order_id, kind, amount, parent_document_id, refund_operation_id)
       VALUES ($1, 'return', 5000, $2, $3)`,
      [ids.orderB, ids.saleB, ids.refundB],
    );
  });

  it('orders.current_payment_attempt_id має FK на payment_attempts', async () => {
    await expectFkViolation(
      'UPDATE orders SET current_payment_attempt_id = gen_random_uuid() WHERE id = $1',
      [ids.orderA],
    );
  });
});

describe('0005_touch_updated_at', () => {
  it('UPDATE оновлює updated_at без участі застосунку', async () => {
    const { id } = await one<{ id: string }>(
      app,
      `INSERT INTO categories (slug, name_uk, name_en, updated_at)
       VALUES ('touch', 'Т', 'T', now() - interval '1 day') RETURNING id`,
    );
    await app.query(`UPDATE categories SET name_en = 'T2' WHERE id = $1`, [id]);
    const { fresh } = await one<{ fresh: boolean }>(
      app,
      `SELECT updated_at > now() - interval '1 minute' AS fresh FROM categories WHERE id = $1`,
      [id],
    );
    expect(fresh).toBe(true);
  });
});

describe('0005/0007 touch_updated_at coverage', () => {
  it('every table with an updated_at column has the touch trigger', async () => {
    const { rows } = await root.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
          AND NOT EXISTS (
            SELECT 1 FROM pg_trigger t
              JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE t.tgrelid = format('public.%I', c.table_name)::regclass
               AND NOT t.tgisinternal AND p.proname = 'touch_updated_at')
        ORDER BY 1`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([]);
  });

  it('a plain UPDATE moves updated_at on a table 0005 had missed (settings)', async () => {
    await app.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('touch-probe', '{}', now() - interval '1 day')`,
    );
    await app.query(`UPDATE settings SET value = '{"a":1}' WHERE key = 'touch-probe'`);
    const { fresh } = await one<{ fresh: boolean }>(
      app,
      `SELECT updated_at > now() - interval '1 minute' AS fresh FROM settings WHERE key = 'touch-probe'`,
    );
    expect(fresh).toBe(true);
  });
});

describe('0006_cart_version_trigger', () => {
  let cartId: string;
  let variantId: string;

  const version = async (): Promise<number> =>
    (await one<{ version: number }>(app, 'SELECT version FROM carts WHERE id = $1', [cartId]))
      .version;

  beforeAll(async () => {
    const { id: categoryId } = await one<{ id: string }>(
      app,
      `INSERT INTO categories (slug, name_uk, name_en) VALUES ('cv-cat', 'K', 'C') RETURNING id`,
    );
    const { id: productId } = await one<{ id: string }>(
      app,
      `INSERT INTO products (sku, slug, brand, category_id, name_uk, name_en, base_price)
       VALUES ('CV-1', 'cv-1', 'B', $1, 'T', 'T', 1000) RETURNING id`,
      [categoryId],
    );
    const { id: sizeId } = await one<{ id: string }>(
      app,
      `INSERT INTO sizes (system, label) VALUES ('apparel', 'CV') RETURNING id`,
    );
    const { id: colorId } = await one<{ id: string }>(
      app,
      `INSERT INTO colors (slug, name_uk, name_en, hex) VALUES ('cv', 'K', 'C', '#000000')
       RETURNING id`,
    );
    ({ id: variantId } = await one<{ id: string }>(
      app,
      `INSERT INTO product_variants (product_id, size_id, color_id, sku)
       VALUES ($1, $2, $3, 'CV-1-1') RETURNING id`,
      [productId, sizeId, colorId],
    ));
    ({ id: cartId } = await one<{ id: string }>(
      app,
      `INSERT INTO carts (token) VALUES ('cv-cart') RETURNING id`,
    ));
  });

  it('bumps carts.version on insert, update and delete of cart_items', async () => {
    expect(await version()).toBe(1);
    const { id } = await one<{ id: string }>(
      app,
      'INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, 1) RETURNING id',
      [cartId, variantId],
    );
    expect(await version()).toBe(2);
    await app.query('UPDATE cart_items SET quantity = 2 WHERE id = $1', [id]);
    expect(await version()).toBe(3);
    await app.query('DELETE FROM cart_items WHERE id = $1', [id]);
    expect(await version()).toBe(4);
  });

  // FOR NO KEY UPDATE does not conflict with the FK check's KEY SHARE lock, so
  // only the trigger's UPDATE of carts can block the writer here.
  it('takes a lock on the parent cart (ADR-22: trigger locks are real locks)', async () => {
    const holder = await connect(inject('pgAppUrl'));
    const writer = await connect(inject('pgAppUrl'));
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM carts WHERE id = $1 FOR NO KEY UPDATE', [cartId]);
      await writer.query('BEGIN');
      await writer.query(`SET LOCAL lock_timeout = '300ms'`);
      await expect(
        writer.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, 1)', [
          cartId,
          variantId,
        ]),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await writer.query('ROLLBACK');
      await holder.query('ROLLBACK');
      await holder.end();
      await writer.end();
    }
  });
  it('moving an item between carts bumps both carts', async () => {
    const { id: otherId } = await one<{ id: string }>(
      app,
      `INSERT INTO carts (token) VALUES ('cv-cart-2') RETURNING id`,
    );
    const { id } = await one<{ id: string }>(
      app,
      'INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, 1) RETURNING id',
      [cartId, variantId],
    );
    const before = await version();
    const otherBefore = (
      await one<{ version: number }>(app, 'SELECT version FROM carts WHERE id = $1', [otherId])
    ).version;
    await app.query('UPDATE cart_items SET cart_id = $1 WHERE id = $2', [otherId, id]);
    expect(await version()).toBe(before + 1);
    const otherAfter = await one<{ version: number }>(
      app,
      'SELECT version FROM carts WHERE id = $1',
      [otherId],
    );
    expect(otherAfter.version).toBe(otherBefore + 1);
  });

  it('deleting a cart cascades to its items without error', async () => {
    const { id: doomed } = await one<{ id: string }>(
      app,
      `INSERT INTO carts (token) VALUES ('cv-doomed') RETURNING id`,
    );
    await app.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, 1)', [
      doomed,
      variantId,
    ]);
    await app.query('DELETE FROM carts WHERE id = $1', [doomed]);
    const { n } = await one<{ n: string }>(
      app,
      'SELECT count(*) AS n FROM cart_items WHERE cart_id = $1',
      [doomed],
    );
    expect(Number(n)).toBe(0);
  });

  it('a cart change makes an intent bound to the old version stale', async () => {
    const { id: staleCart } = await one<{ id: string }>(
      app,
      `INSERT INTO carts (token) VALUES ('cv-intent') RETURNING id`,
    );
    const { id: intentId } = await one<{ id: string }>(
      app,
      `INSERT INTO checkout_intents (cart_id, cart_version, owner_token, expires_at)
       VALUES ($1, 1, 'cv-intent', now() + interval '1 hour') RETURNING id`,
      [staleCart],
    );
    await app.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, 1)', [
      staleCart,
      variantId,
    ]);
    const { stale } = await one<{ stale: boolean }>(
      app,
      `SELECT c.version <> i.cart_version AS stale
         FROM checkout_intents i JOIN carts c ON c.id = i.cart_id WHERE i.id = $1`,
      [intentId],
    );
    expect(stale).toBe(true);
  });
});

/** ON DELETE RESTRICT reports 23001, not the 23503 of a missing parent. */
const RESTRICT_VIOLATION = '23001';

describe('0007_phase2_integrity', () => {
  const ids = { orderA: '', orderB: '', attemptA: '', attemptB: '', returnA: '', giftCard: '' };

  async function insertOrder(email: string): Promise<string> {
    const { id } = await one<{ id: string }>(
      app,
      `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name,
                           delivery_method, subtotal, total)
       VALUES (next_order_number(), $1, '+380000000000', 'Test', 'np_warehouse', 10000, 10000)
       RETURNING id`,
      [email],
    );
    return id;
  }
  const attempt = async (orderId: string): Promise<string> =>
    (
      await one<{ id: string }>(
        app,
        `INSERT INTO payment_attempts (order_id, attempt_number, provider, amount)
         VALUES ($1, 1, 'mono', 10000) RETURNING id`,
        [orderId],
      )
    ).id;
  const violation = async (sql: string, params: unknown[]): Promise<void> => {
    await expect(app.query(sql, params)).rejects.toMatchObject({ code: FK_VIOLATION });
  };

  beforeAll(async () => {
    ids.orderA = await insertOrder('rr1a@example.com');
    ids.orderB = await insertOrder('rr1b@example.com');
    ids.attemptA = await attempt(ids.orderA);
    ids.attemptB = await attempt(ids.orderB);
    ids.returnA = (
      await one<{ id: string }>(
        app,
        `INSERT INTO return_requests (request_number, order_id, reason, policy_version)
         VALUES (next_return_number(), $1, 'wrong_size', 'v1') RETURNING id`,
        [ids.orderA],
      )
    ).id;
    ids.giftCard = (
      await one<{ id: string }>(
        app,
        `INSERT INTO gift_cards (code_hash, last4, initial_amount, balance)
         VALUES ('hash-rr1', '1234', 10000, 10000) RETURNING id`,
      )
    ).id;
  });

  it('checkout_intents.quoted_total is nullable and rejects a negative amount', async () => {
    const { id: cart } = await one<{ id: string }>(
      app,
      `INSERT INTO carts (token) VALUES ('qt-cart') RETURNING id`,
    );
    const insert = async (version: number, quoted: number | null): Promise<void> => {
      await app.query(
        `INSERT INTO checkout_intents (cart_id, cart_version, owner_token, expires_at, quoted_total)
         VALUES ($1, $2, 'qt-cart', now() + interval '1 hour', $3)`,
        [cart, version, quoted],
      );
    };
    await insert(1, null);
    await insert(2, 0);
    await expect(insert(3, -1)).rejects.toMatchObject({ code: '23514' });
  });

  it('a payment event cannot point to an attempt of another order', async () => {
    await violation(
      `INSERT INTO payment_events (order_id, payment_attempt_id, provider, message_key, raw_payload)
       VALUES ($1, $2, 'mono', 'rr1-evt-bad', '{}')`,
      [ids.orderA, ids.attemptB],
    );
    await app.query(
      `INSERT INTO payment_events (order_id, payment_attempt_id, provider, message_key, raw_payload)
       VALUES ($1, $2, 'mono', 'rr1-evt-ok', '{}')`,
      [ids.orderA, ids.attemptA],
    );
  });

  it('a refund cannot point to an attempt of another order', async () => {
    await violation(
      `INSERT INTO refund_operations (order_id, payment_attempt_id, amount) VALUES ($1, $2, 100)`,
      [ids.orderA, ids.attemptB],
    );
    await app.query(
      `INSERT INTO refund_operations (order_id, payment_attempt_id, amount) VALUES ($1, $2, 100)`,
      [ids.orderA, ids.attemptA],
    );
  });

  it('a refund must reference a real return request of the same order', async () => {
    await violation(
      `INSERT INTO refund_operations (order_id, return_request_id, amount) VALUES ($1, gen_random_uuid(), 100)`,
      [ids.orderA],
    );
    await violation(
      `INSERT INTO refund_operations (order_id, return_request_id, amount) VALUES ($1, $2, 100)`,
      [ids.orderB, ids.returnA],
    );
    await app.query(
      `INSERT INTO refund_operations (order_id, return_request_id, amount) VALUES ($1, $2, 100)`,
      [ids.orderA, ids.returnA],
    );
  });

  it('a gift card transaction cannot point to an attempt of another order', async () => {
    await violation(
      `INSERT INTO gift_card_transactions (gift_card_id, type, order_id, payment_attempt_id, amount, balance_after)
       VALUES ($1, 'redeem', $2, $3, -100, 9900)`,
      [ids.giftCard, ids.orderA, ids.attemptB],
    );
  });

  it("orders.current_payment_attempt_id must be the order's own attempt", async () => {
    await violation('UPDATE orders SET current_payment_attempt_id = $1 WHERE id = $2', [
      ids.attemptB,
      ids.orderA,
    ]);
    await app.query('UPDATE orders SET current_payment_attempt_id = $1 WHERE id = $2', [
      ids.attemptA,
      ids.orderA,
    ]);
  });

  it("an attempt that is some order's current one cannot be deleted (RESTRICT, not SET NULL)", async () => {
    // Fresh rows: the attempt has no other child, so only orders_current_attempt_fk can refuse.
    const order = await insertOrder('restrict-attempt@example.com');
    const only = await attempt(order);
    await app.query('UPDATE orders SET current_payment_attempt_id = $1 WHERE id = $2', [
      only,
      order,
    ]);
    await expect(
      app.query('DELETE FROM payment_attempts WHERE id = $1', [only]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION, constraint: 'orders_current_attempt_fk' });
  });

  it('an order with status history cannot be deleted (RESTRICT, not CASCADE)', async () => {
    // Fresh order with nothing but history, so only the history FK can refuse.
    const order = await insertOrder('restrict-history@example.com');
    await app.query(
      `INSERT INTO order_status_history (order_id, to_status, source) VALUES ($1, 'pending', 'test')`,
      [order],
    );
    await expect(app.query('DELETE FROM orders WHERE id = $1', [order])).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
      constraint: 'order_status_history_order_id_orders_id_fk',
    });
  });
});

describe('0008_attempt_needs_order', () => {
  it('an event or gift card transaction naming an attempt must name the order', async () => {
    const { id: order } = await one<{ id: string }>(
      app,
      `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name,
                           delivery_method, subtotal, total)
       VALUES (next_order_number(), 'n8@example.com', '+380000000000', 'Test', 'np_warehouse', 100, 100)
       RETURNING id`,
    );
    const { id: attempt } = await one<{ id: string }>(
      app,
      `INSERT INTO payment_attempts (order_id, attempt_number, provider, amount)
       VALUES ($1, 1, 'mono', 100) RETURNING id`,
      [order],
    );
    await expect(
      app.query(
        `INSERT INTO payment_events (order_id, payment_attempt_id, provider, message_key, raw_payload)
         VALUES (NULL, $1, 'mono', 'n8-bad', '{}')`,
        [attempt],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Both NULL (a quarantine-like event) and both set stay legal.
    await app.query(
      `INSERT INTO payment_events (order_id, payment_attempt_id, provider, message_key, raw_payload)
       VALUES (NULL, NULL, 'mono', 'n8-null', '{}'), ($1, $2, 'mono', 'n8-ok', '{}')`,
      [order, attempt],
    );
    const { id: card } = await one<{ id: string }>(
      app,
      `INSERT INTO gift_cards (code_hash, last4, initial_amount, balance)
       VALUES ('hash-n8', '4321', 100, 100) RETURNING id`,
    );
    await expect(
      app.query(
        `INSERT INTO gift_card_transactions (gift_card_id, type, order_id, payment_attempt_id, amount, balance_after)
         VALUES ($1, 'redeem', NULL, $2, -10, 90)`,
        [card, attempt],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await app.query(
      `INSERT INTO gift_card_transactions (gift_card_id, type, order_id, payment_attempt_id, amount, balance_after)
       VALUES ($1, 'redeem', $2, $3, -10, 90)`,
      [card, order, attempt],
    );
  });
});

describe('0009_fiscal_uniqueness_reconcile_rotation', () => {
  const UNIQUE_VIOLATION = '23505';

  async function order(email: string): Promise<string> {
    return (
      await one<{ id: string }>(
        app,
        `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name,
                             delivery_method, subtotal, total)
         VALUES (next_order_number(), $1, '+380000000000', 'Test', 'np_warehouse', 100, 100)
         RETURNING id`,
        [email],
      )
    ).id;
  }
  const document = async (
    orderId: string,
    kind: string,
    parent: string | null,
    refund: string | null,
  ): Promise<string> =>
    (
      await one<{ id: string }>(
        app,
        `INSERT INTO fiscal_documents (order_id, kind, parent_document_id, refund_operation_id, amount)
         VALUES ($1, $2, $3, $4, 100) RETURNING id`,
        [orderId, kind, parent, refund],
      )
    ).id;
  const refund = async (orderId: string): Promise<string> =>
    (
      await one<{ id: string }>(
        app,
        `INSERT INTO refund_operations (order_id, amount) VALUES ($1, 50) RETURNING id`,
        [orderId],
      )
    ).id;

  it('a second sale document for one order is rejected, another order is fine', async () => {
    const a = await order('q35a@example.com');
    const b = await order('q35b@example.com');
    await document(a, 'sale', null, null);
    await expect(document(a, 'sale', null, null)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await document(b, 'sale', null, null);
  });

  it('one return per refund operation; several returns per order are fine', async () => {
    const o = await order('q35c@example.com');
    const sale = await document(o, 'sale', null, null);
    const r1 = await refund(o);
    const r2 = await refund(o);
    await document(o, 'return', sale, r1);
    await expect(document(o, 'return', sale, r1)).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
    await document(o, 'return', sale, r2);
  });

  it('payment_attempts.last_reconciled_at exists, is nullable and has the rotation index', async () => {
    const column = await one<{ is_nullable: string }>(
      app,
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'payment_attempts' AND column_name = 'last_reconciled_at'`,
    );
    expect(column.is_nullable).toBe('YES');
    const index = await one<{ indexdef: string }>(
      app,
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'payment_attempts_reconcile_idx'`,
    );
    expect(index.indexdef).toContain('NULLS FIRST');
  });
});

describe('0010 and 0011: stock_adjustments', () => {
  async function variant(): Promise<string> {
    const stamp = String(Date.now()) + String(Math.random()).slice(2, 6);
    const { id: category } = await one<{ id: string }>(
      app,
      `INSERT INTO categories (slug, name_uk, name_en) VALUES ($1, 'k', 'c') RETURNING id`,
      [`cat-${stamp}`],
    );
    const { id: product } = await one<{ id: string }>(
      app,
      `INSERT INTO products (sku, slug, brand, category_id, name_uk, name_en, base_price)
       VALUES ($1, $2, 'b', $3, 'n', 'n', 100) RETURNING id`,
      [`P-${stamp}`, `p-${stamp}`, category],
    );
    const { id: size } = await one<{ id: string }>(
      app,
      `INSERT INTO sizes (system, label) VALUES ('apparel', $1) RETURNING id`,
      [`S${stamp}`.slice(0, 20)],
    );
    const { id: color } = await one<{ id: string }>(
      app,
      `INSERT INTO colors (slug, name_uk, name_en, hex) VALUES ($1, 'c', 'c', '#000000') RETURNING id`,
      [`c-${stamp}`],
    );
    return (
      await one<{ id: string }>(
        app,
        `INSERT INTO product_variants (product_id, size_id, color_id, sku, stock_quantity)
         VALUES ($1, $2, $3, $4, 5) RETURNING id`,
        [product, size, color, `V-${stamp}`],
      )
    ).id;
  }
  const insert = async (
    variantId: string,
    delta: number,
    before: number,
    after: number,
    reason = 'receipt',
  ) =>
    await app.query(
      `INSERT INTO stock_adjustments (variant_id, reason, delta, quantity_before, quantity_after)
       VALUES ($1, $2, $3, $4, $5)`,
      [variantId, reason, delta, before, after],
    );

  const rejectedBy = async (constraint: string, run: Promise<unknown>): Promise<void> => {
    await expect(run).rejects.toMatchObject({ code: '23514', constraint });
  };

  it('accepts a row that adds up', async () => {
    const id = await variant();
    await insert(id, 3, 5, 8);
  });
  it('stock_adjustments_adds_up rejects a row whose after is not before plus delta', async () => {
    await rejectedBy('stock_adjustments_adds_up', insert(await variant(), 3, 5, 9));
  });
  it('stock_adjustments_nonneg rejects a negative quantity', async () => {
    await rejectedBy('stock_adjustments_nonneg', insert(await variant(), -6, 5, -1));
  });
  it('stock_adjustments_delta_nonzero rejects a zero delta', async () => {
    await rejectedBy('stock_adjustments_delta_nonzero', insert(await variant(), 0, 5, 5));
  });
  it('stock_adjustments_reason rejects an unknown reason', async () => {
    await rejectedBy('stock_adjustments_reason', insert(await variant(), 1, 5, 6, 'gift'));
  });

  it('request_id is unique, several rows without one are fine', async () => {
    const id = await variant();
    const key = async () =>
      await app.query(
        `INSERT INTO stock_adjustments (variant_id, reason, delta, quantity_before, quantity_after, request_id)
         VALUES ($1, 'receipt', 1, 5, 6, '5b6c7d8e-9f01-4a23-8b45-6c7d8e9f0a11')`,
        [id],
      );
    await key();
    await expect(key()).rejects.toMatchObject({
      code: '23505',
      constraint: 'stock_adjustments_request_uq',
    });
    await insert(id, 1, 5, 6);
    await insert(id, 1, 5, 6);
  });

  it('is append-only: the app role is denied UPDATE, DELETE and TRUNCATE (42501), and a trigger stops every role', async () => {
    const id = await variant();
    await insert(id, 1, 5, 6);
    await expect(
      app.query(`UPDATE stock_adjustments SET note = 'x' WHERE variant_id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query(`DELETE FROM stock_adjustments WHERE variant_id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`TRUNCATE stock_adjustments`)).rejects.toMatchObject({ code: '42501' });
    // The owner role is not stopped by privileges, only by the trigger.
    await expect(
      migrator.query(`UPDATE stock_adjustments SET note = 'x' WHERE variant_id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      migrator.query(`DELETE FROM stock_adjustments WHERE variant_id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(migrator.query(`TRUNCATE stock_adjustments`)).rejects.toMatchObject({
      code: '23001',
    });
  });

  it('a user with stock history cannot be deleted (RESTRICT): history keeps its author', async () => {
    const id = await variant();
    const { id: user } = await one<{ id: string }>(
      app,
      `INSERT INTO auth_users (email) VALUES ($1) RETURNING id`,
      [`history-${String(Date.now())}@example.test`],
    );
    await app.query(
      `INSERT INTO stock_adjustments (variant_id, user_id, reason, delta, quantity_before, quantity_after)
       VALUES ($1, $2, 'receipt', 1, 5, 6)`,
      [id, user],
    );
    await expect(app.query(`DELETE FROM auth_users WHERE id = $1`, [user])).rejects.toMatchObject({
      code: '23001',
    });
  });

  it('a variant with history cannot be deleted (RESTRICT)', async () => {
    const id = await variant();
    await insert(id, 1, 5, 6);
    await expect(
      app.query(`DELETE FROM product_variants WHERE id = $1`, [id]),
    ).rejects.toMatchObject({
      // 23001: RESTRICT is checked at once (23503 is NO ACTION at commit).
      code: '23001',
    });
  });
});

describe('0012_variant_barcode_unique', () => {
  it('a barcode is unique among variants that have one; any number may have none', async () => {
    const stamp = String(Date.now());
    const { id: category } = await one<{ id: string }>(
      app,
      `INSERT INTO categories (slug, name_uk, name_en) VALUES ($1, 'k', 'c') RETURNING id`,
      [`bc-cat-${stamp}`],
    );
    const { id: product } = await one<{ id: string }>(
      app,
      `INSERT INTO products (sku, slug, brand, category_id, name_uk, name_en, base_price)
       VALUES ($1, $2, 'b', $3, 'n', 'n', 100) RETURNING id`,
      [`BC-${stamp}`, `bc-${stamp}`, category],
    );
    const { id: color } = await one<{ id: string }>(
      app,
      `INSERT INTO colors (slug, name_uk, name_en, hex) VALUES ($1, 'c', 'c', '#000000') RETURNING id`,
      [`bc-col-${stamp}`],
    );
    const variant = async (sku: string, label: string, barcode: string | null) => {
      const { id: size } = await one<{ id: string }>(
        app,
        `INSERT INTO sizes (system, label) VALUES ('apparel', $1) RETURNING id`,
        [label],
      );
      await app.query(
        `INSERT INTO product_variants (product_id, size_id, color_id, sku, barcode) VALUES ($1, $2, $3, $4, $5)`,
        [product, size, color, sku, barcode],
      );
    };
    await variant(`BC-V1-${stamp}`, `Z1${stamp}`.slice(0, 20), '5901234123457');
    await expect(
      variant(`BC-V2-${stamp}`, `Z2${stamp}`.slice(0, 20), '5901234123457'),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'variants_barcode_uq',
    });
    await variant(`BC-V3-${stamp}`, `Z3${stamp}`.slice(0, 20), null);
    await variant(`BC-V4-${stamp}`, `Z4${stamp}`.slice(0, 20), null);
  });
});

describe('0013_shipment_one_live', () => {
  it('an order has one live shipment operation; a failed one does not block the next', async () => {
    const stamp = String(Date.now());
    const { id: order } = await one<{ id: string }>(
      app,
      `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method, subtotal, total)
       VALUES ($1, 'a@b.co', '+380501112233', 'n', 'np_warehouse', 100, 100) RETURNING id`,
      [`SH-2026-${stamp.slice(-6)}`],
    );
    const make = async (state: string) =>
      await app.query(
        `INSERT INTO shipment_operations (order_id, carrier, state) VALUES ($1, 'nova_poshta', $2)`,
        [order, state],
      );
    await make('failed');
    await make('failed');
    await make('pending');
    for (const state of ['pending', 'in_flight', 'unknown', 'succeeded']) {
      await expect(make(state), state).rejects.toMatchObject({
        code: '23505',
        constraint: 'shipment_one_live_uq',
      });
    }
    await app.query(
      `UPDATE shipment_operations SET state = 'failed' WHERE order_id = $1 AND state = 'pending'`,
      [order],
    );
    await make('succeeded');
    await expect(make('pending')).rejects.toMatchObject({ code: '23505' });
    // A live operation of ANOTHER order is not in the way.
    const { id: other } = await one<{ id: string }>(
      app,
      `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method, subtotal, total)
       VALUES ($1, 'a@b.co', '+380501112233', 'n', 'np_warehouse', 100, 100) RETURNING id`,
      [`SH-2026-${stamp.slice(-5)}9`],
    );
    await app.query(
      `INSERT INTO shipment_operations (order_id, carrier, state) VALUES ($1, 'nova_poshta', 'pending')`,
      [other],
    );
  });
});

describe('0014_q42_fiscal_check_drop_open_idx', () => {
  it('the superseded index is gone and a return receipt must name its refund', async () => {
    const gone = await app.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'payment_attempts_open_idx'`,
    );
    expect(gone.rowCount).toBe(0);
    // The rotation index that replaced it stays.
    expect(
      (
        await app.query(
          `SELECT 1 FROM pg_indexes WHERE indexname = 'payment_attempts_reconcile_idx'`,
        )
      ).rowCount,
    ).toBe(1);
    const { id: order } = await one<{ id: string }>(
      app,
      `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method, subtotal, total)
       VALUES ($1, 'a@b.co', '+380501112233', 'n', 'pickup', 100, 100) RETURNING id`,
      ['FC-2026-014014'],
    );
    const { id: sale } = await one<{ id: string }>(
      app,
      `INSERT INTO fiscal_documents (order_id, kind, amount) VALUES ($1, 'sale', 100) RETURNING id`,
      [order],
    );
    await expect(
      app.query(
        `INSERT INTO fiscal_documents (order_id, kind, parent_document_id, amount) VALUES ($1, 'return', $2, 50)`,
        [order, sale],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'fiscal_docs_return_has_refund' });
    const { id: refund } = await one<{ id: string }>(
      app,
      `INSERT INTO refund_operations (order_id, amount) VALUES ($1, 50) RETURNING id`,
      [order],
    );
    await app.query(
      `INSERT INTO fiscal_documents (order_id, kind, parent_document_id, refund_operation_id, amount) VALUES ($1, 'return', $2, $3, 50)`,
      [order, sale, refund],
    );
  });
});

describe('0015_customer_auth', () => {
  it('a session is an admin one unless it says otherwise; the audience is a closed list', async () => {
    const { id: user } = await one<{ id: string }>(
      app,
      `INSERT INTO auth_users (email) VALUES ('aud@example.test') RETURNING id`,
    );
    const { audience } = await one<{ audience: string }>(
      app,
      `INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING audience`,
      [user],
    );
    expect(audience).toBe('admin');
    await expect(
      app.query(
        `INSERT INTO auth_sessions (user_id, expires_at, audience) VALUES ($1, now(), 'root')`,
        [user],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it('an e-mail link row names a purpose from a closed list and follows its user', async () => {
    const { id: user } = await one<{ id: string }>(
      app,
      `INSERT INTO auth_users (email) VALUES ('tok@example.test') RETURNING id`,
    );
    const { locale } = await one<{ locale: string }>(
      app,
      `INSERT INTO auth_email_tokens (user_id, purpose, expires_at) VALUES ($1, 'verify_email', now() + interval '1 day') RETURNING locale`,
      [user],
    );
    expect(locale).toBe('uk');
    await expect(
      app.query(
        `INSERT INTO auth_email_tokens (user_id, purpose, expires_at) VALUES ($1, 'login', now())`,
        [user],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
    await app.query(`DELETE FROM auth_users WHERE id = $1`, [user]);
    expect(
      (await app.query(`SELECT 1 FROM auth_email_tokens WHERE user_id = $1`, [user])).rowCount,
    ).toBe(0);
  });

  it('a customer e-mail is stored in lower case (Q56)', async () => {
    await expect(
      app.query(`INSERT INTO customers (email) VALUES ('Mixed@Example.test')`),
    ).rejects.toMatchObject({ code: '23514', constraint: 'customers_email_lower' });
    await app.query(`INSERT INTO customers (email) VALUES ('mixed@example.test')`);
  });

  it('the guest-order claim by address uses an index, not a scan', async () => {
    const { rows } = await app.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_email_lower_idx'`,
    );
    expect(rows[0]?.indexdef).toContain('lower((customer_email)::text)');
  });
});

describe('0017_review_moderation', () => {
  it('a refused review is a column, and the two review checks exist', async () => {
    const column = await app.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'reviews' AND column_name = 'rejected_at'`,
    );
    expect(column.rowCount).toBe(1);
    const checks = await app.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname IN ('reviews_not_both', 'reviews_text_length') ORDER BY 1`,
    );
    expect(checks.rows.map((row) => row.conname)).toEqual([
      'reviews_not_both',
      'reviews_text_length',
    ]);
  });
});

describe('0016_email_token_checks', () => {
  it('a link cannot expire before it was made or be used before it existed (pinned by constraint name)', async () => {
    const { id: user } = await one<{ id: string }>(
      app,
      `INSERT INTO auth_users (email) VALUES ('checks016@example.test') RETURNING id`,
    );
    await expect(
      app.query(
        `INSERT INTO auth_email_tokens (user_id, purpose, expires_at, created_at)
         VALUES ($1, 'verify_email', now() - interval '1 hour', now())`,
        [user],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'auth_email_tokens_expiry' });
    await expect(
      app.query(
        `INSERT INTO auth_email_tokens (user_id, purpose, expires_at, created_at, used_at)
         VALUES ($1, 'verify_email', now() + interval '1 hour', now(), now() - interval '1 day')`,
        [user],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'auth_email_tokens_used_after_created' });
    await app.query(
      `INSERT INTO auth_email_tokens (user_id, purpose, expires_at) VALUES ($1, 'verify_email', now() + interval '1 hour')`,
      [user],
    );
  });
});

describe('0017_review_moderation constraints and 0018_review_indexes', () => {
  it('a review text is at most 2000 characters and a review is never approved and refused at once (by constraint name)', async () => {
    const { id: category } = await one<{ id: string }>(
      app,
      `INSERT INTO categories (slug, name_uk, name_en, size_system) VALUES ('rv-cat', 'c', 'c', 'apparel') RETURNING id`,
    );
    const { id: product } = await one<{ id: string }>(
      app,
      `INSERT INTO products (slug, sku, brand, category_id, name_uk, name_en, base_price)
       VALUES ('rv-p', 'rv-sku', 'b', $1, 'p', 'p', 100) RETURNING id`,
      [category],
    );
    const { id: customer } = await one<{ id: string }>(
      app,
      `INSERT INTO customers (email) VALUES ('rv@example.test') RETURNING id`,
    );
    await expect(
      app.query(
        `INSERT INTO reviews (product_id, customer_id, rating, body) VALUES ($1, $2, 5, $3)`,
        [product, customer, 'x'.repeat(2001)],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'reviews_text_length' });
    await expect(
      app.query(
        `INSERT INTO reviews (product_id, customer_id, rating, admin_reply) VALUES ($1, $2, 5, $3)`,
        [product, customer, 'x'.repeat(2001)],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'reviews_text_length' });
    await expect(
      app.query(
        `INSERT INTO reviews (product_id, customer_id, rating, is_approved, rejected_at) VALUES ($1, $2, 5, true, now())`,
        [product, customer],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'reviews_not_both' });
    await app.query(
      `INSERT INTO reviews (product_id, customer_id, rating, body) VALUES ($1, $2, 5, $3)`,
      [product, customer, 'x'.repeat(2000)],
    );
  });

  it('the moderation queue index excludes refused reviews and the daily cap has an index led by the customer', async () => {
    const { rows } = await app.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('reviews_pending_idx', 'reviews_customer_created_idx') ORDER BY 1`,
    );
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('reviews_pending_idx')).toContain('rejected_at IS NULL');
    expect(byName.get('reviews_customer_created_idx')).toContain('(customer_id, created_at)');
  });
});

describe('0020_return_invariants', () => {
  it('the customer list and the open-request count have an index led by the customer', async () => {
    const { rows } = await app.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'return_requests_customer_idx'`,
    );
    expect(rows[0]?.indexdef).toContain('(customer_id, created_at)');
  });
});

describe('0019_returns_flow', () => {
  it('a return has at most one refund operation (partial unique index) and the stock history accepts the reason `return`', async () => {
    const { id: order } = await one<{ id: string }>(
      app,
      `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method, subtotal, total)
       VALUES ($1, 'ret@b.co', '+380501112233', 'n', 'pickup', 100, 100) RETURNING id`,
      ['RT-2026-018018'],
    );
    const { id: refund } = await one<{ id: string }>(
      app,
      `INSERT INTO refund_operations (order_id, amount) VALUES ($1, 50) RETURNING id`,
      [order],
    );
    const make = async (suffix: string): Promise<string> =>
      (
        await one<{ id: string }>(
          app,
          `INSERT INTO return_requests (request_number, order_id, reason, policy_version)
           VALUES (next_return_number(), $1, 'defect', $2) RETURNING id`,
          [order, `v-${suffix}`],
        )
      ).id;
    const first = await make('a');
    const second = await make('b');
    await app.query(
      `UPDATE return_requests SET refund_amount = 50, refund_operation_id = $1 WHERE id = $2`,
      [refund, first],
    );
    await expect(
      app.query(
        `UPDATE return_requests SET refund_amount = 50, refund_operation_id = $1 WHERE id = $2`,
        [refund, second],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'return_requests_refund_op_uq' });
    await expect(
      app.query(`UPDATE return_requests SET refund_amount = -1 WHERE id = $1`, [second]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'return_requests_refund_nonneg' });
    const reason = await app.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'stock_adjustments_reason'`,
    );
    expect(reason.rows[0]?.def).toContain("'return'");
    expect((await one<{ n: string }>(app, `SELECT next_return_number() AS n`)).n).toMatch(
      /^RET-\d{4}-\d{5,}$/,
    );
  });
});

describe('0021 and 0022: legal_documents', () => {
  const CHECK = '23514';
  const INSERT = `INSERT INTO legal_documents (kind, version, locale, title, status, body_html, effective_from, published_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`;
  const make = async (
    over: Partial<
      Record<
        'kind' | 'version' | 'locale' | 'title' | 'status' | 'html' | 'start' | 'stamp',
        string | null
      >
    > = {},
  ) =>
    (
      await one<{ id: string }>(app, INSERT, [
        over.kind ?? 'terms',
        over.version ?? '1',
        over.locale ?? 'uk',
        over.title ?? 'Title',
        over.status ?? 'draft',
        over.html === undefined ? '<p>x</p>' : over.html,
        over.start ?? new Date().toISOString(),
        over.stamp === undefined ? null : over.stamp,
      ])
    ).id;
  let n = 0;
  const fresh = async (status: 'draft' | 'published') => {
    n += 1;
    // `published` rows are inserted directly (an INSERT is not guarded); the stamp CHECK needs published_at.
    return await make({
      kind: 'faq',
      locale: 'uk',
      version: String(n),
      status,
      stamp: status === 'published' ? new Date().toISOString() : null,
    });
  };
  const violation = async (promise: Promise<unknown>, constraint: string) => {
    await expect(promise).rejects.toMatchObject({ code: CHECK, constraint });
  };

  it('every CHECK refuses its own bad row, by SQLSTATE and constraint name', async () => {
    await violation(make({ kind: 'offer' }), 'legal_docs_kind');
    await violation(make({ locale: 'de' }), 'legal_docs_locale');
    await violation(make({ status: 'archived' }), 'legal_docs_status');
    await violation(make({ version: 'v2' }), 'legal_docs_version_format');
    await violation(make({ version: '0' }), 'legal_docs_version_format');
    await violation(make({ title: '   ' }), 'legal_docs_title_nonblank');
    await violation(make({ status: 'published', stamp: null }), 'legal_docs_published_stamp');
    await violation(make({ html: 'x'.repeat(200_001) }), 'legal_docs_body_size');
    await violation(make({ html: null }), 'legal_docs_has_content');
    await violation(
      app.query(`UPDATE legal_documents SET file_url = 'https://m.example/a.pdf' WHERE id = $1`, [
        await fresh('draft'),
      ]),
      'legal_docs_file_pair',
    );
    await violation(
      app.query(`UPDATE legal_documents SET file_key = 'legal/a.pdf' WHERE id = $1`, [
        await fresh('draft'),
      ]),
      'legal_docs_file_pair',
    );
    await violation(
      app.query(`UPDATE legal_documents SET body_source = $2 WHERE id = $1`, [
        await fresh('draft'),
        'x'.repeat(100_001),
      ]),
      'legal_docs_body_size',
    );
  });

  it('two published versions of one document cannot start at the same instant; a draft may share it', async () => {
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const stamp = new Date().toISOString();
    await make({ kind: 'about', version: '1', status: 'published', start, stamp });
    await expect(
      make({ kind: 'about', version: '2', status: 'published', start, stamp }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'legal_docs_published_start_uq',
    });
    await make({ kind: 'about', version: '3', status: 'draft', start });
  });

  const COLUMNS: [string, string, unknown][] = [
    ['title', 'title', 'Other'],
    ['body_source', 'body_source', 'changed'],
    ['body_html', 'body_html', '<p>changed</p>'],
    ['file_url and file_key', "file_url = 'https://m.example/a.pdf', file_key = $2", 'legal/a.pdf'],
    ['file_size', 'file_size', 7],
    ['kind', 'kind', 'privacy'],
    ['version', 'version', '99'],
    ['locale', 'locale', 'en'],
    ['effective_from', 'effective_from', new Date(Date.now() + 86_400_000).toISOString()],
    ['published_at', 'published_at', new Date(0).toISOString()],
    ['published_by_user_id', 'published_by_user_id', '00000000-0000-4000-8000-0000000000ee'],
    ['uploaded_by_user_id', 'uploaded_by_user_id', '00000000-0000-4000-8000-0000000000ee'],
    ['created_at', 'created_at', new Date(0).toISOString()],
    ['id', 'id', '00000000-0000-4000-8000-0000000000ef'],
  ];
  for (const [label, assignment, value] of COLUMNS) {
    it(`a published row refuses a change of ${label} (legal_documents_guard_immutable)`, async () => {
      const id = await fresh('published');
      const set = assignment.includes('=') ? assignment : `${assignment} = $2`;
      await violation(
        app.query(`UPDATE legal_documents SET ${set} WHERE id = $1`, [id, value]),
        'legal_documents_guard_immutable',
      );
    });
  }

  it('a published row cannot go back to draft, be deleted or be truncated; a draft can be deleted', async () => {
    const id = await fresh('published');
    await violation(
      app.query(`UPDATE legal_documents SET status = 'draft' WHERE id = $1`, [id]),
      'legal_documents_guard_status',
    );
    await violation(
      app.query(`DELETE FROM legal_documents WHERE id = $1`, [id]),
      'legal_documents_guard_delete',
    );
    // The app role has no TRUNCATE privilege at all; the owner is stopped by the trigger.
    await expect(app.query(`TRUNCATE legal_documents`)).rejects.toMatchObject({ code: '42501' });
    await violation(migrator.query(`TRUNCATE legal_documents`), 'legal_documents_guard_truncate');
    const draft = await fresh('draft');
    await app.query(`DELETE FROM legal_documents WHERE id = $1`, [draft]);
  });

  it('only updated_at may move on a published row, and a draft publishes once with a start that is not in the past', async () => {
    const id = await fresh('published');
    await app.query(`UPDATE legal_documents SET updated_at = now() WHERE id = $1`, [id]);
    const draft = await fresh('draft');
    await violation(
      app.query(
        `UPDATE legal_documents SET status = 'published', published_at = now(), effective_from = now() - interval '2 hours' WHERE id = $1`,
        [draft],
      ),
      'legal_documents_guard_past_start',
    );
    await app.query(
      `UPDATE legal_documents SET status = 'published', published_at = now(), effective_from = now() WHERE id = $1`,
      [draft],
    );
  });

  it('the redundant current-version index is gone and the touch trigger moves updated_at on a draft', async () => {
    const gone = await root.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'legal_docs_current_idx'`,
    );
    expect(gone.rowCount).toBe(0);
    const id = await fresh('draft');
    const before = await one<{ updated_at: Date }>(
      app,
      `SELECT updated_at FROM legal_documents WHERE id = $1`,
      [id],
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.query(`UPDATE legal_documents SET title = 'again' WHERE id = $1`, [id]);
    const after = await one<{ updated_at: Date }>(
      app,
      `SELECT updated_at FROM legal_documents WHERE id = $1`,
      [id],
    );
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});
