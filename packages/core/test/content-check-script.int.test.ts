/**
 * `pnpm content:check` as a PROCESS, against real Postgres: the exit codes of the gate, the JSON
 * output, the refusals, and that it leaves the database exactly as it found it.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { addProduct, seedDictionaries } from './content-fixture.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let good: TestDatabase;
let bad: TestDatabase;
let goodHandle: DbHandle;
let badHandle: DbHandle;

function run(args: string[], env: Record<string, string | undefined>) {
  const result = spawnSync(process.execPath, ['scripts/content-check.ts', ...args], {
    cwd: root,
    env: { ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

beforeAll(async () => {
  good = await createTestDatabase();
  bad = await createTestDatabase();
  goodHandle = createDb(good.appUrl, { max: 2 });
  badHandle = createDb(bad.appUrl, { max: 2 });
  await goodHandle.db.transaction(async (tx) => {
    const dict = await seedDictionaries(tx);
    await tx.execute(sql`UPDATE categories SET is_active = false WHERE slug <> 'ready-cat'`);
    await addProduct(tx, dict, { key: 'one', categoryId: dict.categoryId });
  });
  await badHandle.db.transaction(async (tx) => {
    const dict = await seedDictionaries(tx);
    await addProduct(tx, dict, { key: 'nophoto', categoryId: dict.categoryId, images: [] });
  });
});
afterAll(async () => {
  await goodHandle.close();
  await badHandle.close();
  await good.drop();
  await bad.drop();
});

const counts = async (handle: DbHandle): Promise<string> => {
  const result = await handle.db.execute(sql`
    SELECT (SELECT count(*) FROM products) p, (SELECT count(*) FROM product_images) i,
           (SELECT count(*) FROM audit_log) a, (SELECT count(*) FROM categories) c,
           (SELECT max(updated_at) FROM products) u`);
  return JSON.stringify(result.rows);
};

describe('content:check', () => {
  it('exits 0 on a catalogue that passes the gate, 1 when it fails', () => {
    expect(run(['--gate', '--expected-active=1'], { DATABASE_URL: good.appUrl })).toMatchObject({
      code: 0,
    });
    const failed = run(['--gate', '--expected-active=1'], { DATABASE_URL: bad.appUrl });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('GATE: FAIL');
  });
  it('--report-only never fails on the gate', () => {
    expect(run(['--report-only'], { DATABASE_URL: bad.appUrl }).code).toBe(0);
  });
  it('--json prints one JSON document on stdout and the summary on stderr', () => {
    const result = run(['--json', '--report-only'], { DATABASE_URL: bad.appUrl });
    const parsed: unknown = JSON.parse(result.out);
    expect(parsed).toMatchObject({ gatePassed: false, totals: { products: 1 } });
    expect(result.err).toContain('GATE: FAIL');
    expect(result.out).not.toMatch(/cost/i);
  });
  it('writes nothing', async () => {
    const before = await counts(badHandle);
    run(['--json'], { DATABASE_URL: bad.appUrl });
    run(['--gate'], { DATABASE_URL: bad.appUrl });
    expect(await counts(badHandle)).toBe(before);
  });
  it('refuses a production-looking database without connecting, and never prints the password', () => {
    const result = run([], {
      DATABASE_URL: 'postgres://app:hunter2@db.prod.example.test:5432/store',
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain('refused');
    expect(result.err + result.out).not.toContain('hunter2');
  });
  it('the production process may read its own database (the refusal is for everywhere else)', () => {
    const result = run([], {
      DATABASE_URL: bad.appUrl.replace('localhost', '127.0.0.1'),
      APP_ENV: 'production',
    });
    expect(result.code).not.toBe(2);
  });
  it('refuses a missing URL and an unknown argument', () => {
    expect(run([], {}).code).toBe(2);
    expect(run(['--write'], { DATABASE_URL: bad.appUrl }).code).toBe(2);
    expect(run(['--expected-active=abc'], { DATABASE_URL: bad.appUrl }).code).toBe(2);
  });
});
