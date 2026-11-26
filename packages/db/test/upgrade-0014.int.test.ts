/**
 * The upgrade path of 0014 (owner queue Q42): it drops the superseded `payment_attempts_open_idx`
 * and adds `CHECK fiscal_docs_return_has_refund` (a return receipt names its refund). A database at
 * 0013 that ALREADY holds a return receipt without a refund operation fails the migration with the
 * guard's message (naming the offending rows), stays at 0013, and applies once they are resolved.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const UPGRADE_DB = 'store_upgrade_0014';

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

async function applyUpTo0013(): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0014');
  scratch = mkdtempSync(join(tmpdir(), 'upgrade-0014-'));
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
  await applyUpTo0013();
});

afterAll(async () => {
  await upgradeRoot.end();
  await root.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await root.end();
  rmSync(scratch, { recursive: true, force: true });
});

const hasOpenIndex = async (): Promise<boolean> =>
  (
    await upgradeRoot.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'payment_attempts_open_idx'`,
    )
  ).rowCount === 1;
const hasCheck = async (): Promise<boolean> =>
  (
    await upgradeRoot.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'fiscal_docs_return_has_refund'`,
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

let orphanId = '';

describe('0014 over a database that already holds a return receipt without a refund', () => {
  it('is at 0013 before the test: the old index is there, the check is not', async () => {
    expect(await hasOpenIndex()).toBe(true);
    expect(await hasCheck()).toBe(false);
  });

  it('the migration fails with the guard message and the schema stays at 0013', async () => {
    const o = await order('orphan-return@example.test');
    const { rows: sale } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO fiscal_documents (order_id, kind, amount) VALUES ($1, 'sale', 100) RETURNING id`,
      [o],
    );
    const { rows: orphan } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO fiscal_documents (order_id, kind, parent_document_id, amount) VALUES ($1, 'return', $2, 50) RETURNING id`,
      [o, sale[0]?.id],
    );
    orphanId = orphan[0]?.id ?? '';
    const failure: unknown = await runMigrations(migrateUrl).then(
      () => null,
      (error: unknown) => error,
    );
    const cause: unknown = failure instanceof Error ? failure.cause : undefined;
    expect(cause instanceof Error ? cause.message : '').toContain(
      '0014: a return receipt has no refund',
    );
    // The message names the offending rows (DETAIL).
    const detail: unknown =
      typeof cause === 'object' && cause !== null && 'detail' in cause ? cause.detail : '';
    expect(detail).toContain(orphanId);
    expect(await hasOpenIndex()).toBe(true);
    expect(await hasCheck()).toBe(false);
    await upgradeRoot.query(
      `DELETE FROM fiscal_documents WHERE kind = 'return' AND order_id = $1`,
      [o],
    );
  });

  it('once resolved it applies: the index is gone, the check holds, rows are kept', async () => {
    await runMigrations(migrateUrl);
    expect(await hasOpenIndex()).toBe(false);
    expect(await hasCheck()).toBe(true);
    const { rows } = await upgradeRoot.query<{ n: string }>(
      `SELECT count(*) AS n FROM fiscal_documents`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
