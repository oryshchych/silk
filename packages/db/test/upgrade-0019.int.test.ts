/**
 * The upgrade path of 0019 and 0020 (returns) over a database at 0019 that already holds stock history with every
 * old reason: all rows survive and stay valid, the reason `return` is accepted and a made-up one is refused by the
 * rebuilt CHECK, a return's refund must be of the same order (the composite key, RESTRICT on delete), and at most one
 * live refund per return exists.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const UPGRADE_DB = 'store_upgrade_0019';

interface Journal {
  entries: { tag: string }[];
}

const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

let root: pg.Client;
let upgradeRoot: pg.Client;
let migrateUrl: string;
let scratch: string;

async function applyUpTo0018(): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0019');
  scratch = mkdtempSync(join(tmpdir(), 'upgrade-0019-'));
  mkdirSync(join(scratch, 'meta'));
  for (const entry of keep)
    cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(scratch, `${entry.tag}.sql`));
  writeFileSync(
    join(scratch, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: keep }),
  );
  const client = new pg.Client({ connectionString: migrateUrl });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: scratch });
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  root = new pg.Client({ connectionString: inject('pgRootUrl') });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await root.query(`CREATE DATABASE ${UPGRADE_DB} OWNER store_migrate`);
  upgradeRoot = new pg.Client({ connectionString: withDatabase(inject('pgRootUrl'), UPGRADE_DB) });
  await upgradeRoot.connect();
  migrateUrl = withDatabase(inject('pgMigrateUrl'), UPGRADE_DB);
  await applyUpTo0018();
});

afterAll(async () => {
  await upgradeRoot.end();
  await root.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await root.end();
  rmSync(scratch, { recursive: true, force: true });
});

let variantId = '';

describe('0019 and 0020 over a database that already holds stock history', () => {
  it('is at 0018 before the test: the reason CHECK does not know `return`', async () => {
    const def = await upgradeRoot.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'stock_adjustments_reason'`,
    );
    expect(def.rows[0]?.def).not.toContain("'return'");
    const { rows: category } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO categories (slug, name_uk, name_en, size_system) VALUES ('c', 'c', 'c', 'apparel') RETURNING id`,
    );
    const { rows: product } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO products (slug, sku, brand, category_id, name_uk, name_en, base_price)
       VALUES ('p', 'sku1', 'b', $1, 'p', 'p', 100) RETURNING id`,
      [category[0]?.id],
    );
    const { rows: color } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO colors (slug, name_uk, name_en, hex) VALUES ('black', 'b', 'b', '#000000') RETURNING id`,
    );
    const { rows: size } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO sizes (system, label) VALUES ('apparel', 'M') RETURNING id`,
    );
    const { rows: variant } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO product_variants (product_id, size_id, color_id, sku, stock_quantity)
       VALUES ($1, $2, $3, 'v-sku', 100) RETURNING id`,
      [product[0]?.id, size[0]?.id, color[0]?.id],
    );
    variantId = variant[0]?.id ?? '';
    for (const reason of ['receipt', 'writeoff', 'stocktake', 'correction', 'import']) {
      await upgradeRoot.query(
        `INSERT INTO stock_adjustments (variant_id, reason, delta, quantity_before, quantity_after)
         VALUES ($1, $2, 1, 10, 11)`,
        [variantId, reason],
      );
    }
  });

  it('applies: every old row survives, `return` is accepted, a made-up reason is refused by name', async () => {
    await runMigrations(migrateUrl);
    expect((await upgradeRoot.query(`SELECT 1 FROM stock_adjustments`)).rowCount).toBe(5);
    await upgradeRoot.query(
      `INSERT INTO stock_adjustments (variant_id, reason, delta, quantity_before, quantity_after)
       VALUES ($1, 'return', 2, 11, 13)`,
      [variantId],
    );
    await expect(
      upgradeRoot.query(
        `INSERT INTO stock_adjustments (variant_id, reason, delta, quantity_before, quantity_after)
         VALUES ($1, 'bogus', 1, 13, 14)`,
        [variantId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'stock_adjustments_reason' });
  });

  it('a return cannot point at a refund of another order, the refund cannot be deleted while linked (RESTRICT), and one live refund per return', async () => {
    const order = async (number: string): Promise<string> =>
      (
        await upgradeRoot.query<{ id: string }>(
          `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method, subtotal, total)
           VALUES ($1, 'u@example.test', '+380501112233', 'n', 'pickup', 100, 100) RETURNING id`,
          [number],
        )
      ).rows[0]?.id ?? '';
    const own = await order('RT-2026-019001');
    const other = await order('RT-2026-019002');
    const refund = async (orderId: string): Promise<string> =>
      (
        await upgradeRoot.query<{ id: string }>(
          `INSERT INTO refund_operations (order_id, amount) VALUES ($1, 50) RETURNING id`,
          [orderId],
        )
      ).rows[0]?.id ?? '';
    const { rows: ret } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO return_requests (request_number, order_id, reason, policy_version, refund_amount)
       VALUES (next_return_number(), $1, 'defect', 'v', 50) RETURNING id`,
      [own],
    );
    const returnId = ret[0]?.id ?? '';
    await expect(
      upgradeRoot.query(`UPDATE return_requests SET refund_operation_id = $1 WHERE id = $2`, [
        await refund(other),
        returnId,
      ]),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'return_requests_refund_op_same_order_fk',
    });
    const mine = await refund(own);
    await upgradeRoot.query(`UPDATE return_requests SET refund_operation_id = $1 WHERE id = $2`, [
      mine,
      returnId,
    ]);
    await expect(
      upgradeRoot.query(`DELETE FROM refund_operations WHERE id = $1`, [mine]),
    ).rejects.toMatchObject({
      // ON DELETE RESTRICT reports SQLSTATE 23001 (restrict_violation), not 23503.
      code: '23001',
    });
    await upgradeRoot.query(`UPDATE refund_operations SET return_request_id = $1 WHERE id = $2`, [
      returnId,
      mine,
    ]);
    const second = await refund(own);
    await expect(
      upgradeRoot.query(`UPDATE refund_operations SET return_request_id = $1 WHERE id = $2`, [
        returnId,
        second,
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'refund_ops_return_live_uq' });
    // A failed one does not count: the retry is allowed.
    await upgradeRoot.query(`UPDATE refund_operations SET state = 'failed' WHERE id = $1`, [mine]);
    await upgradeRoot.query(`UPDATE refund_operations SET return_request_id = $1 WHERE id = $2`, [
      returnId,
      second,
    ]);
  });
});
