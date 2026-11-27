/**
 * The upgrade path of 0025 (banner admin) over a database at 0024 that already holds a hand-made banner row:
 * the row is brought inside the new rules (no picture without dimensions, switched off, link and period fixed),
 * the CHECKs then refuse an incomplete active banner, an external link and a reversed period, and the touch
 * trigger keeps `updated_at` fresh.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder } from '../src/migrate.ts';

const DB = 'store_upgrade_0025';

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
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-0025-'));
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

describe('migration 0025', () => {
  it('brings a hand-made row inside the rules and enforces them afterwards', async () => {
    await run('0024_newsletter_request_nonce');
    const client = new pg.Client({ connectionString: withDatabase(inject('pgRootUrl'), DB) });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO banners (image_desktop_url, image_mobile_url, href, position, starts_at, ends_at, is_active)
         VALUES ('https://x.test/a.webp', 'https://x.test/b.webp', 'https://evil.example/', 'sidebar',
                 now() + interval '2 days', now() + interval '1 day', true)`,
      );
      await run('0025_banners_admin');
      const row = (
        await client.query<{
          d: string | null;
          m: string | null;
          href: string | null;
          position: string;
          ends: boolean;
          active: boolean;
        }>(
          `SELECT image_desktop_url AS d, image_mobile_url AS m, href, position, ends_at IS NULL AS ends, is_active AS active FROM banners`,
        )
      ).rows[0];
      expect(row).toEqual({
        d: null,
        m: null,
        href: null,
        position: 'home_hero',
        ends: true,
        active: false,
      });
      await expect(
        client.query(`INSERT INTO banners (is_active) VALUES (true)`),
      ).rejects.toMatchObject({
        constraint: 'banners_active_complete',
      });
      await expect(
        client.query(
          `INSERT INTO banners (is_active, href) VALUES (false, 'https://evil.example')`,
        ),
      ).rejects.toMatchObject({ constraint: 'banners_href_internal' });
      await expect(
        client.query(
          `INSERT INTO banners (is_active, starts_at, ends_at) VALUES (false, now() + interval '2 days', now() + interval '1 day')`,
        ),
      ).rejects.toMatchObject({ constraint: 'banners_dates_order' });
      await expect(
        client.query(
          `INSERT INTO banners (is_active, image_desktop_url) VALUES (false, 'https://x.test/a.webp')`,
        ),
      ).rejects.toMatchObject({ constraint: 'banners_images_both_or_none' });
      const created = await client.query<{ id: string }>(
        `INSERT INTO banners (is_active, href) VALUES (false, '/category/bras') RETURNING id`,
      );
      await client.query(`UPDATE banners SET updated_at = now() - interval '1 day' WHERE id = $1`, [
        created.rows[0]?.id,
      ]);
      await client.query(`UPDATE banners SET sort_order = 3 WHERE id = $1`, [created.rows[0]?.id]);
      const fresh = await client.query<{ fresh: boolean }>(
        `SELECT updated_at > now() - interval '1 minute' AS fresh FROM banners WHERE id = $1`,
        [created.rows[0]?.id],
      );
      expect(fresh.rows[0]?.fresh).toBe(true);
    } finally {
      await client.end();
    }
  });
});
