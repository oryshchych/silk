/**
 * The report transaction on a real pool: read only (a write is refused by Postgres), its own
 * statement timeout (a slow query is cancelled and the connection returns to the pool, unchanged),
 * and one snapshot across statements.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import { inReportTransaction } from '../src/reports/transaction.ts';
import { insertOrder } from './reports-fixture.ts';

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

const codeOf = (error: unknown): string | null => {
  const cause = error instanceof Error ? error.cause : null;
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : null;
};

describe('inReportTransaction', () => {
  it('refuses a write (25006) and leaves nothing behind', async () => {
    const attempt = inReportTransaction(handle.db, async (tx) => {
      await tx.execute(sql`INSERT INTO settings (key, value) VALUES ('x', '{}'::jsonb)`);
    });
    await expect(attempt).rejects.toSatisfy((error: unknown) => codeOf(error) === '25006');
    const rows = await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM settings WHERE key = 'x'`,
    );
    expect(rows.rows[0]).toEqual({ n: 0 });
  });

  it('cancels a slow statement at its own timeout (57014) and the single connection is usable again', async () => {
    const started = performance.now();
    const slow = inReportTransaction(
      handle.db,
      async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(5)`);
      },
      { statementTimeoutMs: 300 },
    );
    await expect(slow).rejects.toSatisfy((error: unknown) => codeOf(error) === '57014');
    expect(performance.now() - started).toBeLessThan(3_000);
    // A pool of ONE connection: if the timeout had stayed on it, or the connection were lost, this would hang or fail.
    const after = await handle.db.execute(sql`SELECT current_setting('statement_timeout') AS t`);
    expect(after.rows[0]).not.toEqual({ t: '300ms' });
  });

  it('names the session and reads one snapshot across statements', async () => {
    const seen = await inReportTransaction(handle.db, async (tx) => {
      const name = await tx.execute(sql`SELECT current_setting('application_name') AS n`);
      const first = await tx.execute(sql`SELECT count(*)::int AS n FROM orders`);
      // A concurrent writer commits between the two reads; repeatable read must not show it.
      const other = createDb(testDb.appUrl, { max: 1 });
      try {
        await other.db.transaction(async (w) => {
          await insertOrder(w, { lines: [{ quantity: 1, price: 100, cost: null }] });
        });
      } finally {
        await other.close();
      }
      const second = await tx.execute(sql`SELECT count(*)::int AS n FROM orders`);
      return { name: name.rows[0], first: first.rows[0], second: second.rows[0] };
    });
    expect(seen.name).toEqual({ n: 'silk-report' });
    expect(seen.first).toEqual(seen.second);
  });
});
