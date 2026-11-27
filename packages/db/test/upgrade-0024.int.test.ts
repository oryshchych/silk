/**
 * The upgrade path of 0024 (newsletter request nonce, one spelling per mailbox) over a database at 0023 that
 * already holds subscribers, including two rows that differ only by case: the older one survives, every address
 * is lower-cased, every row has its own nonce, and an upper-case address is refused afterwards.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder } from '../src/migrate.ts';

const DB = 'store_upgrade_0024';

interface Journal {
  entries: { tag: string }[];
}

const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

let root: pg.Client;
let scratch = '';

async function run(database: string, upTo: string): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag <= upTo);
  scratch = mkdtempSync(join(tmpdir(), 'upgrade-0024-'));
  mkdirSync(join(scratch, 'meta'));
  for (const entry of keep)
    cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(scratch, `${entry.tag}.sql`));
  writeFileSync(
    join(scratch, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: keep }),
  );
  const migrator = new pg.Client({
    connectionString: withDatabase(inject('pgMigrateUrl'), database),
  });
  await migrator.connect();
  try {
    await migrate(drizzle({ client: migrator }), { migrationsFolder: scratch });
  } finally {
    await migrator.end();
  }
  rmSync(scratch, { recursive: true, force: true });
}

beforeAll(async () => {
  root = new pg.Client({ connectionString: inject('pgRootUrl') });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${DB}`);
  await root.query(`CREATE DATABASE ${DB} OWNER store_migrate`);
});
afterAll(async () => {
  await root.query(`DROP DATABASE IF EXISTS ${DB}`);
  await root.end();
});

describe('migration 0024', () => {
  it('merges case duplicates, lower-cases, gives every row a nonce and refuses upper case after', async () => {
    await run(DB, '0023_report_indexes');
    const client = new pg.Client({ connectionString: withDatabase(inject('pgRootUrl'), DB) });
    await client.connect();
    try {
      // `newsletter_email_uq` is case sensitive before 0024, so both spellings can exist.
      await client.query(
        `INSERT INTO newsletter_subscribers (email, created_at, confirmed_at) VALUES
           ('Legacy@Example.Test', now() - interval '2 days', now() - interval '2 days'),
           ('legacy@example.test', now() - interval '1 day', NULL),
           ('Solo@Example.Test', now(), NULL),
           ('plain@example.test', now(), NULL)`,
      );
      await run(DB, '0024_newsletter_request_nonce');
      const rows = await client.query<{ email: string; confirmed: boolean; nonce: string }>(
        `SELECT email, confirmed_at IS NOT NULL AS confirmed, request_nonce::text AS nonce
           FROM newsletter_subscribers ORDER BY email`,
      );
      expect(rows.rows.map((r) => r.email)).toEqual([
        'legacy@example.test',
        'plain@example.test',
        'solo@example.test',
      ]);
      // The OLDEST of the two spellings survived (it was the confirmed one).
      expect(rows.rows[0]?.confirmed).toBe(true);
      expect(new Set(rows.rows.map((r) => r.nonce)).size).toBe(3);
      await expect(
        client.query(`INSERT INTO newsletter_subscribers (email) VALUES ('Upper@Example.Test')`),
      ).rejects.toMatchObject({ constraint: 'newsletter_email_lower' });
    } finally {
      await client.end();
    }
  });
});
