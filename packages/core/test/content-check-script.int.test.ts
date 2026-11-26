/**
 * `pnpm content:check` as a PROCESS, against real Postgres: the exit codes of the gate, the JSON
 * output, the refusals, and that it leaves the database exactly as it found it.
 */
import { spawn, spawnSync } from 'node:child_process';
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
  it('a slow reader of a big --json still gets the whole document', async () => {
    const big = await createTestDatabase();
    const handle = createDb(big.appUrl, { max: 2 });
    try {
      const dict = await handle.db.transaction(async (tx) => await seedDictionaries(tx));
      await handle.db.execute(sql`
        INSERT INTO products (sku, slug, brand, category_id, name_uk, name_en, base_price, is_active, published_at)
        SELECT 'P-' || n, 'p-' || n, 'Brand', ${dict.categoryId}::uuid, 'Назва ' || n, 'Name ' || n, 100000, true, now()
          FROM generate_series(1, 1500) n`);
      const child = spawn(
        process.execPath,
        ['scripts/content-check.ts', '--json', '--report-only'],
        {
          cwd: root,
          env: { DATABASE_URL: big.appUrl },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const chunks: Buffer[] = [];
      child.stdout.pause();
      // The reader starts late: the process must wait for the pipe, not exit with data unwritten.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stdout.resume();
      await new Promise<void>((resolve) => {
        child.on('close', () => {
          resolve();
        });
      });
      const text = Buffer.concat(chunks).toString('utf8');
      expect(text.length).toBeGreaterThan(200_000);
      expect(() => {
        JSON.parse(text);
      }).not.toThrow();
    } finally {
      await handle.close();
      await big.drop();
    }
  }, 60_000);
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
    const url = 'postgres://app:hunter2@db.prod.example.test:5432/store';
    for (const args of [[], ['--allow-remote']]) {
      const result = run(args, { DATABASE_URL: url });
      expect(result.code).toBe(2);
      expect(result.err).toContain('refused');
      expect(result.err + result.out).not.toContain('hunter2');
    }
  });
  it('refuses a remote host without --allow-remote and the ?host= redirect even with it', () => {
    expect(
      run([], { DATABASE_URL: 'postgres://u:p@staging.example.test:5432/store' }),
    ).toMatchObject({ code: 2 });
    const redirected = run(['--allow-remote'], {
      DATABASE_URL: `${bad.appUrl}${bad.appUrl.includes('?') ? '&' : '?'}host=prod.example.test`,
    });
    expect(redirected.code).toBe(2);
    expect(redirected.err).toContain('not accepted');
  });
  it('an ambient APP_ENV=production does not switch the refusal off', () => {
    const result = run([], {
      DATABASE_URL: 'postgres://u:p@db.prod.example.test:5432/store',
      APP_ENV: 'production',
    });
    expect(result.code).toBe(2);
  });
  it('a connection failure prints a stable class and the driver code, never the message', () => {
    const result = run([], { DATABASE_URL: 'postgres://user:secretpw@127.0.0.1:1/store' });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/content:check failed: \w+ ECONNREFUSED/);
    expect(result.err).not.toMatch(/secretpw|user/);
  });
  it('refuses a missing URL and an unknown argument', () => {
    expect(run([], {}).code).toBe(2);
    expect(run(['--write'], { DATABASE_URL: bad.appUrl }).code).toBe(2);
    for (const value of ['abc', '1e1', '0x10', '', '-1'])
      expect(run([`--expected-active=${value}`], { DATABASE_URL: bad.appUrl }).code).toBe(2);
    expect(run(['--gate', '--expected-active=0'], { DATABASE_URL: bad.appUrl }).code).toBe(2);
  });
});
