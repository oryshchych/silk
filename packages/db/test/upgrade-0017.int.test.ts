/**
 * The upgrade path of 0017 (review moderation): a database at 0016 that ALREADY holds a review text longer
 * than 2000 characters fails the migration with the guard's message (naming the rows) and stays at 0016; once
 * it is shortened the migration applies and the rows are kept.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const UPGRADE_DB = 'store_upgrade_0017';

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

async function applyUpTo0016(): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0017');
  scratch = mkdtempSync(join(tmpdir(), 'upgrade-0017-'));
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
  await applyUpTo0016();
});

afterAll(async () => {
  await upgradeRoot.end();
  await root.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await root.end();
  rmSync(scratch, { recursive: true, force: true });
});

const hasCheck = async (): Promise<boolean> =>
  (await upgradeRoot.query(`SELECT 1 FROM pg_constraint WHERE conname = 'reviews_text_length'`))
    .rowCount === 1;

let reviewId = '';

describe('0017 over a database that already holds an over-long review', () => {
  it('is at 0016 before the test', async () => {
    expect(await hasCheck()).toBe(false);
  });

  it('fails with the guard message naming the row; the schema stays at 0016', async () => {
    const { rows: category } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO categories (slug, name_uk, name_en, size_system) VALUES ('c', 'c', 'c', 'apparel') RETURNING id`,
    );
    const { rows: product } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO products (slug, sku, brand, category_id, name_uk, name_en, base_price)
       VALUES ('p', 'sku1', 'b', $1, 'p', 'p', 100) RETURNING id`,
      [category[0]?.id],
    );
    const { rows: customer } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO customers (email) VALUES ('r@example.test') RETURNING id`,
    );
    const { rows: review } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO reviews (product_id, customer_id, rating, body) VALUES ($1, $2, 5, $3) RETURNING id`,
      [product[0]?.id, customer[0]?.id, 'x'.repeat(2500)],
    );
    reviewId = review[0]?.id ?? '';
    const failure: unknown = await runMigrations(migrateUrl).then(
      () => null,
      (error: unknown) => error,
    );
    const cause: unknown = failure instanceof Error ? failure.cause : undefined;
    expect(cause instanceof Error ? cause.message : '').toContain(
      '0017: a review text is longer than 2000',
    );
    const detail: unknown =
      typeof cause === 'object' && cause !== null && 'detail' in cause ? cause.detail : '';
    expect(detail).toContain(reviewId);
    expect(await hasCheck()).toBe(false);
    // Nothing of the failed migration is left behind: no column, no constraint.
    const column = await upgradeRoot.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'reviews' AND column_name = 'rejected_at'`,
    );
    expect(column.rowCount).toBe(0);
  });

  it('an over-long shop reply is caught by the same guard', async () => {
    const { rows } = await upgradeRoot
      .query<{ id: string }>(
        `INSERT INTO reviews (product_id, customer_id, rating, body, admin_reply)
       SELECT product_id, customer_id, 4, 'ok', $1 FROM reviews WHERE id = $2 RETURNING id`,
        ['y'.repeat(2500), reviewId],
      )
      .catch(async () => {
        // Same (product, customer) is unique: use the first review's reply instead.
        await upgradeRoot.query(`UPDATE reviews SET admin_reply = $1 WHERE id = $2`, [
          'y'.repeat(2500),
          reviewId,
        ]);
        return { rows: [{ id: reviewId }] };
      });
    expect(rows).toHaveLength(1);
    await upgradeRoot.query(`UPDATE reviews SET body = 'short' WHERE id = $1`, [reviewId]);
    const failure: unknown = await runMigrations(migrateUrl).then(
      () => null,
      (error: unknown) => error,
    );
    const cause: unknown = failure instanceof Error ? failure.cause : undefined;
    expect(cause instanceof Error ? cause.message : '').toContain(
      '0017: a review text is longer than 2000',
    );
    await upgradeRoot.query(`UPDATE reviews SET admin_reply = NULL WHERE id = $1`, [reviewId]);
  });

  it('once shortened it applies and the row is kept', async () => {
    await upgradeRoot.query(`UPDATE reviews SET body = 'short' WHERE id = $1`, [reviewId]);
    await runMigrations(migrateUrl);
    expect(await hasCheck()).toBe(true);
    const kept = await upgradeRoot.query(`SELECT 1 FROM reviews WHERE id = $1`, [reviewId]);
    expect(kept.rowCount).toBe(1);
  });
});
