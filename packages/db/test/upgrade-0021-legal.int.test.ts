/**
 * The upgrade path of 0021 and 0022 (legal documents) over a database at 0020 that already holds legacy rows
 * (nothing in the code wrote the table, but a manual row is possible): `offer` becomes `terms`, `delivery`
 * becomes `delivery_payment`, every old row becomes a published version with a title and a stamp, and the guard
 * is on afterwards. A legacy `offer` next to a `terms` row with the same locale and version collides on the unique
 * index: the whole run fails LOUDLY and ATOMICALLY (the database stays at 0020).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder, runMigrations } from '../src/migrate.ts';

const OK_DB = 'store_upgrade_0021_ok';
const CLASH_DB = 'store_upgrade_0021_clash';

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

async function at0020(database: string): Promise<{ client: pg.Client; migrateUrl: string }> {
  await root.query(`DROP DATABASE IF EXISTS ${database}`);
  await root.query(`CREATE DATABASE ${database} OWNER store_migrate`);
  const migrateUrl = withDatabase(inject('pgMigrateUrl'), database);
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag < '0021');
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-0021-'));
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
  await root.query(`DROP DATABASE IF EXISTS ${OK_DB} WITH (FORCE)`);
  await root.query(`DROP DATABASE IF EXISTS ${CLASH_DB} WITH (FORCE)`);
  await root.end();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const LEGACY = `INSERT INTO legal_documents (kind, version, locale, body_html, effective_from)
                VALUES ($1, $2, $3, '<p>old</p>', now() - interval '3 days')`;

describe('0021 and 0022 over legacy rows', () => {
  it('renames the old kinds, publishes every old row, keeps its text, and the guard is on', async () => {
    const { client, migrateUrl } = await at0020(OK_DB);
    try {
      expect(
        (
          await client.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'legal_documents' AND column_name = 'status'`,
          )
        ).rowCount,
      ).toBe(0);
      await client.query(LEGACY, ['offer', '1', 'uk']);
      await client.query(LEGACY, ['delivery', '1', 'uk']);
      await client.query(LEGACY, ['privacy', '2', 'en']);
      await client.query(LEGACY, ['returns', '1', 'uk']);
      await runMigrations(migrateUrl);
      const { rows } = await client.query<{
        kind: string;
        version: string;
        locale: string;
        title: string;
        status: string;
        body_html: string;
        same_stamp: boolean;
      }>(`SELECT kind, version, locale, title, status, body_html, published_at = created_at AS same_stamp
            FROM legal_documents ORDER BY kind, version`);
      expect(rows).toEqual([
        {
          kind: 'delivery_payment',
          version: '1',
          locale: 'uk',
          title: 'delivery',
          status: 'published',
          body_html: '<p>old</p>',
          same_stamp: true,
        },
        {
          kind: 'privacy',
          version: '2',
          locale: 'en',
          title: 'privacy',
          status: 'published',
          body_html: '<p>old</p>',
          same_stamp: true,
        },
        {
          kind: 'returns',
          version: '1',
          locale: 'uk',
          title: 'returns',
          status: 'published',
          body_html: '<p>old</p>',
          same_stamp: true,
        },
        {
          kind: 'terms',
          version: '1',
          locale: 'uk',
          title: 'offer',
          status: 'published',
          body_html: '<p>old</p>',
          same_stamp: true,
        },
      ]);
      await expect(
        client.query(`UPDATE legal_documents SET body_html = '<p>x</p>' WHERE kind = 'terms'`),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'legal_documents_guard_immutable',
      });
      await expect(
        client.query(`DELETE FROM legal_documents WHERE kind = 'terms'`),
      ).rejects.toMatchObject({
        constraint: 'legal_documents_guard_delete',
      });
    } finally {
      await client.end();
    }
  });

  it('a legacy `offer` that collides with a `terms` row fails the whole run and leaves the database at 0020', async () => {
    const { client, migrateUrl } = await at0020(CLASH_DB);
    try {
      await client.query(LEGACY, ['offer', '1', 'uk']);
      await client.query(LEGACY, ['terms', '1', 'uk']);
      await expect(runMigrations(migrateUrl)).rejects.toMatchObject({ cause: { code: '23505' } });
      // Atomic: not one column, constraint or trigger of 0021 or 0022 exists, and the journal stops at 0020.
      expect(
        (
          await client.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'legal_documents' AND column_name = 'status'`,
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await client.query(`SELECT 1 FROM pg_trigger WHERE tgname LIKE 'legal_documents_%'`))
          .rowCount,
      ).toBe(0);
      const { rows } = await client.query<{ kind: string }>(
        `SELECT kind FROM legal_documents ORDER BY kind`,
      );
      expect(rows.map((r) => r.kind)).toEqual(['offer', 'terms']);
      const applied = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
      );
      expect(applied.rows[0]?.n).toBe(21);
    } finally {
      await client.end();
    }
  });
});
