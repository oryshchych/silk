/**
 * The upgrade path of 0023 (report indexes) over a database at 0022 that already holds rows, and over one where
 * somebody built an index BY HAND first (the advice in the migration for a big table): `IF NOT EXISTS` lets the run
 * pass instead of rolling everything back, and afterwards every index is valid and a window query can use it.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const DB = 'store_upgrade_0023';
const HAND_DB = 'store_upgrade_0023_hand';
const NAMES = [
  'orders_cancelled_at_idx',
  'payment_attempts_captured_at_idx',
  'refund_settled_at_idx',
  'return_requests_received_at_idx',
];

interface Journal {
  entries: { tag: string }[];
}

const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

let root: pg.Client;
const scratch: string[] = [];

async function at0022(database: string): Promise<{ client: pg.Client; migrateUrl: string }> {
  await root.query(`DROP DATABASE IF EXISTS ${database}`);
  await root.query(`CREATE DATABASE ${database} OWNER store_migrate`);
  const migrateUrl = withDatabase(inject('pgMigrateUrl'), database);
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0023');
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-0023-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'meta'));
  for (const entry of keep)
    cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: keep }));
  const migrator = new pg.Client({ connectionString: migrateUrl });
  await migrator.connect();
  try {
    await migrate(drizzle({ client: migrator }), { migrationsFolder: dir });
  } finally {
    await migrator.end();
  }
  const client = new pg.Client({ connectionString: withDatabase(inject('pgRootUrl'), database) });
  await client.connect();
  return { client, migrateUrl };
}

beforeAll(async () => {
  root = new pg.Client({ connectionString: inject('pgRootUrl') });
  await root.connect();
});
afterAll(async () => {
  await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.query(`DROP DATABASE IF EXISTS ${HAND_DB} WITH (FORCE)`);
  await root.end();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function seedRows(client: pg.Client): Promise<void> {
  await client.query(`INSERT INTO orders (order_number, customer_email, customer_phone, customer_name,
      delivery_method, subtotal, total, captured_total, refunded_total, status, cancelled_at)
    SELECT 'LS-UP-' || g, 'a@example.com', '+380501112233', 'A', 'pickup', 1000, 1000, 1000, 0,
           CASE WHEN g % 10 = 0 THEN 'cancelled'::order_status ELSE 'confirmed'::order_status END,
           CASE WHEN g % 10 = 0 THEN now() END
      FROM generate_series(1, 3000) g`);
  await client.query(`INSERT INTO payment_attempts (order_id, attempt_number, provider, state, status, amount,
      captured_amount, completed_at)
    SELECT id, 1, 'mono', 'succeeded', 'paid', 1000, 1000, now() - (random() * 300) * interval '1 day' FROM orders`);
  await client.query(`INSERT INTO refund_operations (order_id, payment_attempt_id, amount, state, settled_at)
    SELECT order_id, id, 100, 'succeeded', completed_at FROM payment_attempts WHERE attempt_number = 1`);
  await client.query('ANALYZE');
}

const indexState = async (client: pg.Client) =>
  (
    await client.query<{ indexname: string; valid: boolean }>(
      `SELECT c.relname AS indexname, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ANY($1) ORDER BY c.relname`,
      [NAMES],
    )
  ).rows;

describe('0023 over a database at 0022 with rows', () => {
  it('creates the four indexes, all valid, and a window query on payments can use one', async () => {
    const { client, migrateUrl } = await at0022(DB);
    try {
      await seedRows(client);
      expect(await indexState(client)).toEqual([]);
      await runMigrations(migrateUrl);
      expect(await indexState(client)).toEqual(
        NAMES.map((indexname) => ({ indexname, valid: true })),
      );
      await client.query('SET enable_seqscan = off');
      const plan = await client.query<Record<string, string>>(
        `EXPLAIN SELECT sum(captured_amount) FROM payment_attempts
          WHERE captured_amount > 0 AND completed_at >= now() - interval '10 days' AND completed_at < now()`,
      );
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'payment_attempts_captured_at_idx',
      );
    } finally {
      await client.end();
    }
  });

  it('passes when an index was built by hand first (IF NOT EXISTS) and leaves it valid', async () => {
    const { client, migrateUrl } = await at0022(HAND_DB);
    try {
      await client.query(
        `CREATE INDEX CONCURRENTLY refund_settled_at_idx ON refund_operations (settled_at) WHERE state = 'succeeded'`,
      );
      await runMigrations(migrateUrl);
      expect(await indexState(client)).toEqual(
        NAMES.map((indexname) => ({ indexname, valid: true })),
      );
    } finally {
      await client.end();
    }
  });
});
