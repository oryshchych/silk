/**
 * The upgrade path of 0018 (review indexes) over a database at 0018 that already holds reviews: the moderation
 * queue index is rebuilt without refused rows, the per-customer index appears, and every row survives.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const UPGRADE_DB = 'store_upgrade_0018';

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

async function applyUpTo0017(): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0018');
  scratch = mkdtempSync(join(tmpdir(), 'upgrade-0018-'));
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
  await applyUpTo0017();
});

afterAll(async () => {
  await upgradeRoot.end();
  await root.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await root.end();
  rmSync(scratch, { recursive: true, force: true });
});

const queueIndex = async (): Promise<string> =>
  (
    await upgradeRoot.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'reviews_pending_idx'`,
    )
  ).rows[0]?.indexdef ?? '';

describe('0018 over a database that already holds pending and refused reviews', () => {
  it('is at 0017 before the test: the queue index still holds every unapproved row, no customer index', async () => {
    expect(await queueIndex()).not.toContain('rejected_at');
    const customerIndex = await upgradeRoot.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'reviews_customer_created_idx'`,
    );
    expect(customerIndex.rowCount).toBe(0);
  });

  it('applies: the queue index drops refused rows, the customer index exists, both reviews are kept', async () => {
    const { rows: category } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO categories (slug, name_uk, name_en, size_system) VALUES ('c', 'c', 'c', 'apparel') RETURNING id`,
    );
    const { rows: product } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO products (slug, sku, brand, category_id, name_uk, name_en, base_price)
       VALUES ('p', 'sku1', 'b', $1, 'p', 'p', 100) RETURNING id`,
      [category[0]?.id],
    );
    for (const [email, refused] of [
      ['a@example.test', false],
      ['b@example.test', true],
    ] as const) {
      const { rows: customer } = await upgradeRoot.query<{ id: string }>(
        `INSERT INTO customers (email) VALUES ($1) RETURNING id`,
        [email],
      );
      await upgradeRoot.query(
        `INSERT INTO reviews (product_id, customer_id, rating, rejected_at) VALUES ($1, $2, 4, ${refused ? 'now()' : 'NULL'})`,
        [product[0]?.id, customer[0]?.id],
      );
    }
    await runMigrations(migrateUrl);
    expect(await queueIndex()).toContain('rejected_at IS NULL');
    const customerIndex = await upgradeRoot.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'reviews_customer_created_idx'`,
    );
    expect(customerIndex.rowCount).toBe(1);
    expect((await upgradeRoot.query(`SELECT 1 FROM reviews`)).rowCount).toBe(2);
  });
});
