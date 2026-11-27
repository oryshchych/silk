/** The promo CSV route: HEAD is refused (no audit row, no file), GET audits once, a manager is refused. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { authUsers } from '@store/db/schema';
import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const USER = '00000000-0000-4000-8000-0000000000ee';
const state = vi.hoisted<{ role: string; handle: unknown }>(() => ({
  role: 'owner',
  handle: null,
}));

vi.mock('@/lib/admin/session', () => ({
  currentSession: () =>
    Promise.resolve({
      kind: 'full',
      session: { sid: 's', userId: USER, email: 'x@example.test', role: state.role },
    }),
}));
vi.mock('@/lib/db', () => ({ getDb: () => Promise.resolve(state.handle) }));
vi.mock('@/lib/request-limits', () => ({ clientAddressOf: () => Promise.resolve('203.0.113.7') }));

const route = await import('../src/app/admin/export/promo-codes/route');

let testDb: TestDatabase;
let handle: DbHandle;
const audits = async (): Promise<number> => {
  const result = await handle.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'promo_code'`,
  );
  return result.rows[0]?.n ?? -1;
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
  state.handle = handle.db;
  await handle.db.insert(authUsers).values({ id: USER, email: 'x@example.test' });
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

describe('GET /admin/export/promo-codes', () => {
  it('HEAD is 405 and writes nothing; GET downloads once with one audit row', async () => {
    const head = route.HEAD();
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toBe('GET');
    expect(await audits()).toBe(0);
    const got = await route.GET(new Request('http://localhost/admin/export/promo-codes'));
    expect(got.status).toBe(200);
    expect(got.headers.get('cache-control')).toBe('private, no-store');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await audits()).toBe(1);
  });

  it('a manager is refused before any query or audit row', async () => {
    state.role = 'manager';
    const got = await route.GET(new Request('http://localhost/admin/export/promo-codes'));
    expect(got.status).toBe(403);
    expect(await audits()).toBe(1);
  });
});
