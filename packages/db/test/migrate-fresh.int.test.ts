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
    await expectFkViolation(
      `INSERT INTO fiscal_documents (order_id, kind, amount, parent_document_id)
       VALUES ($1, 'return', 5000, $2)`,
      [ids.orderA, ids.saleB],
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
