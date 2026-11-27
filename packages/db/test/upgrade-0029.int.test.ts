/**
 * The upgrade path of 0029 (blog tags per element, reserved address, published needs text) over a database at 0028 that
 * holds every shape the old CHECK let through: a tag with a comma, a NULL element, a two-dimensional array, a 41-character
 * tag, the address `tag`, a published post with no text. The migration STOPS with the exact message and the ids of
 * exactly those rows, the failed run rolls back completely (nothing recorded, rows unchanged), and once they are fixed it
 * applies and the boundaries hold.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder } from '../src/migrate.ts';

const DB = 'store_upgrade_0029';

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
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-0029-'));
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

const MESSAGE =
  '0029: a blog post breaks the per-tag, reserved-address or published-needs-text rules; fix it by hand before migrating';

async function failure(promise: Promise<unknown>): Promise<{ message: string; detail: string }> {
  try {
    await promise;
  } catch (error) {
    const inner = (error as { cause?: unknown }).cause ?? error;
    const { message, detail } = inner as { message: string; detail?: string };
    return { message, detail: detail ?? '' };
  }
  throw new Error('the migration did not fail');
}

describe('migration 0029', () => {
  it('stops with the exact message and ids, rolls back, then applies; the boundaries hold', async () => {
    await run('0028_blog_constraints');
    const client = new pg.Client({ connectionString: withDatabase(inject('pgRootUrl'), DB) });
    await client.connect();
    try {
      const add = async (
        slug: string,
        tags: string,
        published = false,
        content = 'text',
      ): Promise<string> =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO blog_posts (slug, title_uk, title_en, tags, content_uk, published_at)
             VALUES ($1, 'x', 'x', ${tags}, $2, ${published ? "now() - interval '1 hour'" : 'NULL'}) RETURNING id`,
            [slug, content],
          )
        ).rows[0]?.id ?? '';
      const good = await add('good', `ARRAY['ok','also-ok']::text[]`);
      const bad = [
        await add('comma-tag', `ARRAY['a,b']::text[]`),
        await add('null-element', `ARRAY[NULL,'a']::text[]`),
        await add('two-dim', `ARRAY[['a','b'],['c','d']]::text[]`),
        await add('long-tag', `ARRAY['${'x'.repeat(41)}']::text[]`),
        await add('tag', `ARRAY[]::text[]`),
        await add('empty-published', `ARRAY[]::text[]`, true, ''),
      ].sort();
      const recorded = async (): Promise<number> =>
        Number(
          (
            await client.query<{ n: string }>(
              `SELECT count(*) AS n FROM drizzle.__drizzle_migrations`,
            )
          ).rows[0]?.n,
        );
      const before = await recorded();

      const stopped = await failure(run('0029_blog_tags_per_element'));
      expect(stopped.message).toBe(MESSAGE);
      expect(stopped.detail.split(',').sort()).toEqual(bad);
      expect(stopped.detail).not.toContain(good);
      // Rolled back completely: nothing recorded, the old constraint and the rows are as they were.
      expect(await recorded()).toBe(before);
      const still = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM blog_posts WHERE cardinality(tags) > 0 AND tags[1] = 'a,b'`,
      );
      expect(still.rows[0]?.n).toBe(1);

      await client.query(`DELETE FROM blog_posts WHERE id = ANY($1::uuid[])`, [bad]);
      await run('0029_blog_tags_per_element');
      expect(await recorded()).toBe(before + 1);

      const insert = (slug: string, tags: string[] | null, content = 'x', published = false) =>
        client.query(
          `INSERT INTO blog_posts (slug, title_uk, title_en, tags, content_uk, published_at)
           VALUES ($1, 'x', 'x', $2::text[], $3, ${published ? 'now()' : 'NULL'})`,
          [slug, tags, content],
        );
      await expect(insert('comma-two', ['a,b'])).rejects.toMatchObject({
        constraint: 'blog_tags_valid',
      });
      await expect(insert('nulls', [null as unknown as string, 'a'])).rejects.toMatchObject({
        constraint: 'blog_tags_valid',
      });
      await expect(
        client.query(
          `INSERT INTO blog_posts (slug, title_uk, title_en, tags) VALUES ('twod', 'x', 'x', ARRAY[['a'],['b']]::text[])`,
        ),
      ).rejects.toMatchObject({ constraint: 'blog_tags_valid' });
      await expect(insert('long-tag-2', ['x'.repeat(41)])).rejects.toMatchObject({
        constraint: 'blog_tags_valid',
      });
      await expect(
        insert(
          'eleven',
          Array.from({ length: 11 }, (_, i) => `t${String(i)}`),
        ),
      ).rejects.toMatchObject({ constraint: 'blog_tags_valid' });
      await expect(insert('tag', [])).rejects.toMatchObject({ constraint: 'blog_slug_reserved' });
      await expect(insert('empty-pub', [], ' ', true)).rejects.toMatchObject({
        constraint: 'blog_published_has_body',
      });
      // Boundaries that are accepted: a 120-character slug, ten tags, a 40-character tag, a 100 000 character body.
      await insert(
        's'.repeat(120),
        Array.from({ length: 10 }, (_, i) => `t${String(i)}`),
      );
      await insert('forty', ['x'.repeat(40)]);
      await insert('big-body', [], 'y'.repeat(100_000), true);
      // Boundaries that are refused: 121 characters, a trailing newline, a 100 001 character body.
      await expect(insert('s'.repeat(121), [])).rejects.toMatchObject({
        constraint: 'blog_slug_format',
      });
      await expect(insert('newline\n', [])).rejects.toMatchObject({
        constraint: 'blog_slug_format',
      });
      await expect(insert('too-big', [], 'y'.repeat(100_001))).rejects.toMatchObject({
        constraint: 'blog_content_length',
      });
    } finally {
      await client.end();
    }
  });
});
