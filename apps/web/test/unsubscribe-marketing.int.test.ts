/** The marketing unsubscribe action: the signed subscriber id is the credential; foreign Origin, forged token do nothing. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildMarketingUnsubscribeToken } from '@store/core/marketing';
import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
const state = vi.hoisted<{ origin: boolean; handle: unknown }>(() => ({
  origin: true,
  handle: null,
}));

vi.mock('@/lib/admin/bound-action', () => ({
  requestOriginOk: () => Promise.resolve(state.origin),
}));
vi.mock('@/lib/admin/config', () => ({ authConfig: () => Promise.resolve({ secret: SECRET }) }));
vi.mock('@/lib/db', () => ({ getDb: () => Promise.resolve(state.handle) }));
vi.mock('@/lib/request-limits', () => ({
  checkLimit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
}));

const { unsubscribeMarketingAction } = await import('../src/actions/unsubscribe');

let testDb: TestDatabase;
let handle: DbHandle;
let subscriberId = '';
beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
  state.handle = handle.db;
  await handle.pool.query(
    `INSERT INTO customers (email, accepts_marketing) VALUES ('a@example.test', true)`,
  );
  const sub = await handle.pool.query<{ id: string }>(
    `INSERT INTO newsletter_subscribers (email, confirmed_at) VALUES ('a@example.test', now()) RETURNING id`,
  );
  subscriberId = sub.rows[0]?.id ?? '';
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

const flag = async (): Promise<boolean> =>
  (await handle.pool.query<{ f: boolean }>(`SELECT accepts_marketing AS f FROM customers`)).rows[0]
    ?.f ?? true;

describe('unsubscribeMarketingAction', () => {
  it('refuses a forged token, a foreign Origin and garbage; a valid token withdraws consent', async () => {
    const token = buildMarketingUnsubscribeToken(SECRET, subscriberId);
    expect(await unsubscribeMarketingAction({ token: `${token}x` })).toEqual({
      status: 'error',
      code: 'invalid',
    });
    expect(await unsubscribeMarketingAction({ nope: 1 })).toEqual({
      status: 'error',
      code: 'invalid',
    });
    state.origin = false;
    expect(await unsubscribeMarketingAction({ token })).toEqual({
      status: 'error',
      code: 'invalid',
    });
    expect(await flag()).toBe(true);
    state.origin = true;
    expect(await unsubscribeMarketingAction({ token })).toEqual({ status: 'done' });
    expect(await flag()).toBe(false);
  });
});
