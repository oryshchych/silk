/**
 * The pool survives the server terminating an idle connection (57P01). Without
 * the `error` listener in `createDb` the pool's error event is unhandled and
 * the process dies; the test would then fail with an unhandled error.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createDb, type DbHandle } from '../src/client.ts';
import { createTestDatabase, type TestDatabase } from './db.ts';

let testDb: TestDatabase;
let handle: DbHandle;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 1 });
});

afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

describe('createDb pool', () => {
  it('keeps working after the server terminates its idle connection', async () => {
    await handle.db.execute(sql`SELECT 1`);

    const root = new pg.Client({ connectionString: inject('pgRootUrl') });
    await root.connect();
    try {
      const database = new URL(testDb.appUrl).pathname.slice(1);
      const terminated = await root.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND usename = 'store_app' AND pid <> pg_backend_pid()`,
        [database],
      );
      expect(terminated.rowCount).toBeGreaterThan(0);
    } finally {
      await root.end();
    }

    // Give the event loop a turn to deliver the pool's error event.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await handle.db.execute(sql`SELECT 1 AS ok`);
    expect(result.rows[0]).toEqual({ ok: 1 });
  });

  it('fails fast with a statement timeout instead of hanging', async () => {
    const strict = createDb(testDb.appUrl, { max: 1, statementTimeoutMs: 200 });
    try {
      await expect(strict.db.execute(sql`SELECT pg_sleep(2)`)).rejects.toThrow();
    } finally {
      await strict.close();
    }
  });
});
