/**
 * The upgrade path of 0026 (stricter banner CHECKs) over a database at 0025 that holds rows the old CHECKs allowed:
 * a whitespace-only alt on an active banner, a link with a space, a picture of width 0, an empty picture address.
 * The migration brings each inside the new rules (a bad picture cleared whole, a bad link cleared, an incomplete banner
 * switched off) and the new CHECKs then refuse each weakness on its own.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder } from '../src/migrate.ts';

const DB = 'store_upgrade_0026';

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
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-0026-'));
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

const PIC = (n: number) =>
  `https://media.test/banners/00000000-0000-4000-8000-00000000000${String(n)}/00000000-0000-4000-8000-0000000000aa/full.webp`;

describe('migration 0026', () => {
  it('cleans rows the old CHECKs allowed, then refuses each weakness', async () => {
    await run('0025_banners_admin');
    const client = new pg.Client({ connectionString: withDatabase(inject('pgRootUrl'), DB) });
    await client.connect();
    try {
      const insert = (
        title: string,
        cols: { alt?: string; href?: string; dw?: number; mw?: number; durl?: string },
      ) =>
        client.query(
          `INSERT INTO banners (title_uk, is_active, alt_uk, alt_en, href, image_desktop_url, image_desktop_width, image_desktop_height,
             image_mobile_url, image_mobile_width, image_mobile_height)
           VALUES ($1, true, $2, 'ok', $3, $4, $5, 600, $6, $7, 800)`,
          [
            title,
            cols.alt ?? 'ok',
            cols.href ?? null,
            cols.durl ?? PIC(1),
            cols.dw ?? 1600,
            PIC(2),
            cols.mw ?? 800,
          ],
        );
      await insert('good', {});
      await insert('blank-alt', { alt: '   ' });
      await insert('space-link', { href: '/a b' });
      await insert('zero-width', { dw: 0 });
      await insert('empty-url', { durl: '' });
      await run('0026_banners_checks_strict');
      const rows = await client.query<{
        t: string;
        active: boolean;
        href: string | null;
        d: string | null;
        dw: number | null;
      }>(
        `SELECT title_uk AS t, is_active AS active, href, image_desktop_url AS d, image_desktop_width AS dw FROM banners ORDER BY title_uk`,
      );
      const by = Object.fromEntries(rows.rows.map((r) => [r.t, r]));
      expect(by['good']).toMatchObject({ active: true, d: PIC(1), dw: 1600 });
      expect(by['blank-alt']).toMatchObject({ active: false });
      expect(by['space-link']).toMatchObject({ active: true, href: null });
      expect(by['zero-width']).toMatchObject({ active: false, d: null, dw: null });
      expect(by['empty-url']).toMatchObject({ active: false, d: null });

      const refuse = async (sql: string, params: unknown[], constraint: string) => {
        await expect(client.query(sql, params)).rejects.toMatchObject({ constraint });
      };
      const base = `INSERT INTO banners (is_active, alt_uk, alt_en, href, image_desktop_url, image_desktop_width, image_desktop_height,
         image_mobile_url, image_mobile_width, image_mobile_height) VALUES ($1, $2, 'ok', $3, $4, $5, 600, $6, 800, 1000)`;
      await refuse(base, [true, ' \t\n', null, PIC(1), 1600, PIC(2)], 'banners_active_complete');
      await refuse(base, [false, 'ok', '/a b', PIC(1), 1600, PIC(2)], 'banners_href_internal');
      await refuse(base, [false, 'ok', '/a\\b', PIC(1), 1600, PIC(2)], 'banners_href_internal');
      await refuse(
        base,
        [false, 'ok', `/${'a'.repeat(2001)}`, PIC(1), 1600, PIC(2)],
        'banners_href_internal',
      );
      await refuse(base, [false, 'ok', null, PIC(1), 0, PIC(2)], 'banners_images_valid');
      await refuse(base, [false, 'ok', null, PIC(1), -5, PIC(2)], 'banners_images_valid');
      await refuse(base, [false, 'ok', null, '', 1600, PIC(2)], 'banners_images_valid');
      await client.query(base, [true, 'ok', '/category/bras?x=1#top', PIC(1), 1600, PIC(2)]);
    } finally {
      await client.end();
    }
  });
});
