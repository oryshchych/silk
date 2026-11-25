/**
 * The upgrade path of 0009 (fiscal uniqueness): a database that is at 0008 and ALREADY holds
 * duplicates must fail the migration as a whole (the migrator runs every pending migration in one
 * transaction), leave the schema at 0008, and apply cleanly once the duplicates are gone. This is
 * the documented precondition in docs/DEVELOPMENT.md; here it is executed, on a database built
 * migration by migration, not on the empty one `migrate:fresh` uses.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const UPGRADE_DB = 'store_upgrade_0009';
const UNIQUE_VIOLATION = '23505';

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

async function applyUpTo0008(): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0009');
  scratch = mkdtempSync(join(tmpdir(), 'upgrade-0009-'));
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
  await applyUpTo0008();
});

afterAll(async () => {
  await upgradeRoot.end();
  await root.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await root.end();
  rmSync(scratch, { recursive: true, force: true });
});

const hasColumn = async (): Promise<boolean> =>
  (
    await upgradeRoot.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'payment_attempts' AND column_name = 'last_reconciled_at'`,
    )
  ).rowCount === 1;

async function order(email: string): Promise<string> {
  const { rows } = await upgradeRoot.query<{ id: string }>(
    `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name,
                         delivery_method, subtotal, total)
     VALUES (next_order_number(), $1, '+380000000000', 'Test', 'np_warehouse', 100, 100)
     RETURNING id`,
    [email],
  );
  return rows[0]?.id ?? '';
}

describe('0009 over a database that already holds duplicates', () => {
  it('is at 0008 before the test: no column, no unique index', async () => {
    expect(await hasColumn()).toBe(false);
  });

  it('two sale documents for one order: the whole migration fails and the schema stays at 0008', async () => {
    const o = await order('dup-sale@example.test');
    for (let i = 0; i < 2; i += 1) {
      await upgradeRoot.query(
        `INSERT INTO fiscal_documents (order_id, kind, amount) VALUES ($1, 'sale', 100)`,
        [o],
      );
    }
    await expect(runMigrations(migrateUrl)).rejects.toMatchObject({
      cause: { code: UNIQUE_VIOLATION },
    });
    // All or nothing: the column of the same migration is not there either.
    expect(await hasColumn()).toBe(false);
    await upgradeRoot.query(
      `DELETE FROM fiscal_documents WHERE id IN (
         SELECT id FROM fiscal_documents WHERE order_id = $1 ORDER BY created_at, id OFFSET 1)`,
      [o],
    );
  });

  it('two return documents for one refund operation fail it the same way', async () => {
    const o = await order('dup-return@example.test');
    const { rows: sale } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO fiscal_documents (order_id, kind, amount) VALUES ($1, 'sale', 100) RETURNING id`,
      [o],
    );
    const { rows: refund } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO refund_operations (order_id, amount) VALUES ($1, 50) RETURNING id`,
      [o],
    );
    for (let i = 0; i < 2; i += 1) {
      await upgradeRoot.query(
        `INSERT INTO fiscal_documents (order_id, kind, parent_document_id, refund_operation_id, amount)
         VALUES ($1, 'return', $2, $3, 50)`,
        [o, sale[0]?.id, refund[0]?.id],
      );
    }
    await expect(runMigrations(migrateUrl)).rejects.toMatchObject({
      cause: { code: UNIQUE_VIOLATION },
    });
    expect(await hasColumn()).toBe(false);
    await upgradeRoot.query(
      `DELETE FROM fiscal_documents WHERE id IN (
         SELECT id FROM fiscal_documents WHERE refund_operation_id = $1 ORDER BY created_at, id OFFSET 1)`,
      [refund[0]?.id],
    );
  });

  it('once the duplicates are gone it applies, and keeps the surviving rows', async () => {
    await runMigrations(migrateUrl);
    expect(await hasColumn()).toBe(true);
    const { rows } = await upgradeRoot.query<{ n: string }>(
      `SELECT count(*) AS n FROM fiscal_documents`,
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });
});
