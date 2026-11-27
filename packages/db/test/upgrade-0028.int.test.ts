/**
 * The upgrade path of 0028 (blog constraints) over a database at 0027: a NULL tag list is normalised to an empty one, a
 * post that breaks the slug rule STOPS the migration (nothing is rewritten silently), and afterwards the CHECKs refuse an
 * upper-case slug, a bad tag, eleven tags and an over-long text, and the touch trigger works.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder } from '../src/migrate.ts';

const DB = 'store_upgrade_0028';

interface Journal {
  entries: { tag: string }[];
}
const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};
let root: pg.Client;

async function run(upTo: string): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal & Record<string, unknown>;
  const keep = journal.entries.filter((entry) => entry.tag <= upTo);
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-0028-'));
  mkdirSync(join(dir, 'meta'));
  for (const entry of keep)
    cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: keep }));
  const migrator = new pg.Client({ connectionString: withDatabase(inject('pgMigrateUrl'), DB) });
  await migrator.connect();
  try {
    await migrate(drizzle({ client: migrator }), { migrationsFolder: dir });
  } finally {
    await migrator.end();
    rmSync(dir, { recursive: true, force: true });
  }
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

describe('migration 0028', () => {
  it('stops on a post that breaks the slug rule, and otherwise normalises and enforces', async () => {
    await run('0027_banners_alt_visible');
    const client = new pg.Client({ connectionString: withDatabase(inject('pgRootUrl'), DB) });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO blog_posts (slug, title_uk, title_en, tags) VALUES ('Bad Slug', 'x', 'x', NULL)`,
      );
      await expect(run('0028_blog_constraints')).rejects.toThrow();
      await client.query(`UPDATE blog_posts SET slug = 'good-slug'`);
      await run('0028_blog_constraints');
      const row = await client.query<{ tags: string[] }>(`SELECT tags FROM blog_posts`);
      expect(row.rows[0]?.tags).toEqual([]);

      const insert = (slug: string, tags: string[], content = 'x') =>
        client.query(
          `INSERT INTO blog_posts (slug, title_uk, title_en, tags, content_uk) VALUES ($1, 'x', 'x', $2, $3)`,
          [slug, tags, content],
        );
      await expect(insert('Upper', [])).rejects.toMatchObject({ constraint: 'blog_slug_format' });
      await expect(insert('a--b', [])).rejects.toMatchObject({ constraint: 'blog_slug_format' });
      await expect(insert('ok-1', ['Upper'])).rejects.toMatchObject({
        constraint: 'blog_tags_valid',
      });
      await expect(
        insert(
          'ok-3',
          Array.from({ length: 11 }, (_, i) => `t${String(i)}`),
        ),
      ).rejects.toMatchObject({
        constraint: 'blog_tags_valid',
      });
      await expect(insert('ok-4', [], 'x'.repeat(100_001))).rejects.toMatchObject({
        constraint: 'blog_content_length',
      });
      await insert('ok-5', ['bras', 'care-tips']);
      await client.query(`UPDATE blog_posts SET updated_at = now() - interval '1 day'`);
      await client.query(`UPDATE blog_posts SET author = 'a'`);
      const fresh = await client.query<{ fresh: boolean }>(
        `SELECT bool_and(updated_at > now() - interval '1 minute') AS fresh FROM blog_posts`,
      );
      expect(fresh.rows[0]?.fresh).toBe(true);
    } finally {
      await client.end();
    }
  });
});
