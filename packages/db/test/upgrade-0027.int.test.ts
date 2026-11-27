/**
 * The upgrade path of 0027 (alt text is visible text, ONE explicit character set) over a database at 0026 that holds
 * active banners whose alt text is only invisible characters: a no-break space, zero-width characters. The migration
 * switches them off; the CHECK then refuses each invisible-only alt on its own and accepts real text.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { migrationsFolder } from '../src/migrate.ts';

const DB = 'store_upgrade_0027';

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
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-0027-'));
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

const INVISIBLE = {
  nbsp: '\u00A0\u00A0',
  zwsp: '\u200B\u200C\u200D',
  wordJoiner: '\u2060',
  bom: '\uFEFF',
  ideographic: '\u3000',
  lineSeparator: '\u2028',
} as const;

describe('migration 0027', () => {
  it('switches off an active banner with invisible-only alt text, then refuses each such alt', async () => {
    await run('0026_banners_checks_strict');
    const client = new pg.Client({ connectionString: withDatabase(inject('pgRootUrl'), DB) });
    await client.connect();
    try {
      const insert = (title: string, altUk: string, altEn: string) =>
        client.query(
          `INSERT INTO banners (title_uk, is_active, alt_uk, alt_en, image_desktop_url, image_desktop_width, image_desktop_height,
             image_mobile_url, image_mobile_width, image_mobile_height)
           VALUES ($1, true, $2, $3, $4, 1600, 600, $4, 800, 1000)`,
          [title, altUk, altEn, PIC(1)],
        );
      await insert('good', 'real text', 'real text');
      // (A no-break space already fails 0026's locale-dependent class on some systems, so the legacy rows use the
      // characters it never caught: zero-width ones and the byte order mark.)
      await insert('zwsp', 'real text', INVISIBLE.zwsp);
      await insert('bom', INVISIBLE.bom, 'real text');
      await run('0027_banners_alt_visible');
      const rows = await client.query<{ t: string; active: boolean }>(
        `SELECT title_uk AS t, is_active AS active FROM banners ORDER BY title_uk`,
      );
      expect(Object.fromEntries(rows.rows.map((r) => [r.t, r.active]))).toEqual({
        good: true,
        zwsp: false,
        bom: false,
      });
      for (const [name, text] of Object.entries(INVISIBLE)) {
        await expect(insert(`bad-${name}`, text, 'real text'), name).rejects.toMatchObject({
          constraint: 'banners_active_complete',
        });
      }
      await insert('visible-after-space', ' \u00A0 x ', 'real text');
    } finally {
      await client.end();
    }
  });
});
