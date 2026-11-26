/**
 * The upgrade path of 0013 (one live shipment operation per order): a database at 0012 that ALREADY
 * holds two live operations for one order fails the migration with a readable message (the guard at
 * the top of the file), stays at 0012, and applies once the duplicates are resolved.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const UPGRADE_DB = 'store_upgrade_0013';

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

async function applyUpTo0012(): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0013');
  scratch = mkdtempSync(join(tmpdir(), 'upgrade-0013-'));
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
  await applyUpTo0012();
});

afterAll(async () => {
  await upgradeRoot.end();
  await root.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await root.end();
  rmSync(scratch, { recursive: true, force: true });
});

const hasIndex = async (): Promise<boolean> =>
  (await upgradeRoot.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'shipment_one_live_uq'`))
    .rowCount === 1;

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

describe('0013 over a database that already holds duplicates', () => {
  it('is at 0012 before the test: no index', async () => {
    expect(await hasIndex()).toBe(false);
  });

  it('two live operations for one order: the migration fails with the guard message and the schema stays at 0012', async () => {
    const dup = await order('dup-live@example.test');
    const fine = await order('one-live@example.test');
    for (const state of ['in_flight', 'unknown']) {
      await upgradeRoot.query(
        `INSERT INTO shipment_operations (order_id, carrier, state) VALUES ($1, 'nova_poshta', $2)`,
        [dup, state],
      );
    }
    await upgradeRoot.query(
      `INSERT INTO shipment_operations (order_id, carrier, state) VALUES ($1, 'nova_poshta', 'succeeded')`,
      [fine],
    );
    const failure: unknown = await runMigrations(migrateUrl).then(
      () => null,
      (error: unknown) => error,
    );
    const cause: unknown = failure instanceof Error ? failure.cause : undefined;
    expect(cause instanceof Error ? cause.message : '').toContain(
      '0013: an order has more than one live',
    );
    expect(await hasIndex()).toBe(false);
    await upgradeRoot.query(
      `UPDATE shipment_operations SET state = 'failed' WHERE order_id = $1 AND state = 'unknown'`,
      [dup],
    );
  });

  it('once resolved it applies and keeps every row; a live row of another order stays allowed', async () => {
    await runMigrations(migrateUrl);
    expect(await hasIndex()).toBe(true);
    const { rows } = await upgradeRoot.query<{ n: string }>(
      `SELECT count(*) AS n FROM shipment_operations`,
    );
    expect(Number(rows[0]?.n)).toBe(3);
    const other = await order('other-live@example.test');
    await upgradeRoot.query(
      `INSERT INTO shipment_operations (order_id, carrier, state) VALUES ($1, 'nova_poshta', 'pending')`,
      [other],
    );
  });
});
