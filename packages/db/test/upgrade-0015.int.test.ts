/**
 * The upgrade path of 0015 (customer accounts): it adds `auth_sessions.audience`, `auth_email_tokens`
 * and `CHECK customers_email_lower`. A database at 0014 that ALREADY holds a customer address in mixed
 * case fails the migration with the guard's message (naming the offending rows) and stays at 0014; once
 * the address is normalised it applies, and sessions that existed before the column stay admin ones.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const UPGRADE_DB = 'store_upgrade_0015';

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

async function applyUpTo0014(): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0015');
  scratch = mkdtempSync(join(tmpdir(), 'upgrade-0015-'));
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
  await applyUpTo0014();
});

afterAll(async () => {
  await upgradeRoot.end();
  await root.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await root.end();
  rmSync(scratch, { recursive: true, force: true });
});

const hasCheck = async (): Promise<boolean> =>
  (await upgradeRoot.query(`SELECT 1 FROM pg_constraint WHERE conname = 'customers_email_lower'`))
    .rowCount === 1;

let badId = '';

describe('0015 over a database that already holds a customer address in mixed case', () => {
  it('is at 0014 before the test: no audience column, no lower-case check', async () => {
    expect(await hasCheck()).toBe(false);
    const { rowCount } = await upgradeRoot.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_sessions' AND column_name = 'audience'`,
    );
    expect(rowCount).toBe(0);
  });

  it('the migration fails with the guard message, names the row, and the schema stays at 0014', async () => {
    const { rows } = await upgradeRoot.query<{ id: string }>(
      `INSERT INTO customers (email) VALUES ('Mixed@Example.test') RETURNING id`,
    );
    badId = rows[0]?.id ?? '';
    const failure: unknown = await runMigrations(migrateUrl).then(
      () => null,
      (error: unknown) => error,
    );
    const cause: unknown = failure instanceof Error ? failure.cause : undefined;
    expect(cause instanceof Error ? cause.message : '').toContain(
      '0015: a customer email is not lower case',
    );
    const detail: unknown =
      typeof cause === 'object' && cause !== null && 'detail' in cause ? cause.detail : '';
    expect(detail).toContain(badId);
    expect(await hasCheck()).toBe(false);
  });

  it('once normalised it applies: the check holds, sessions default to admin, rows are kept', async () => {
    await upgradeRoot.query(`UPDATE customers SET email = lower(email) WHERE id = $1`, [badId]);
    await upgradeRoot.query(
      `INSERT INTO auth_users (id, email) VALUES ('00000000-0000-4000-8000-000000000001', 'old@example.test')`,
    );
    await upgradeRoot.query(
      `INSERT INTO auth_sessions (user_id, expires_at) VALUES ('00000000-0000-4000-8000-000000000001', now() + interval '1 hour')`,
    );
    await runMigrations(migrateUrl);
    expect(await hasCheck()).toBe(true);
    // A session that existed before the column is an admin one: nobody is signed out, nobody is promoted.
    const { rows } = await upgradeRoot.query<{ audience: string }>(
      `SELECT audience FROM auth_sessions`,
    );
    expect(rows.map((row) => row.audience)).toEqual(['admin']);
    const kept = await upgradeRoot.query(`SELECT 1 FROM customers WHERE id = $1`, [badId]);
    expect(kept.rowCount).toBe(1);
  });
});
