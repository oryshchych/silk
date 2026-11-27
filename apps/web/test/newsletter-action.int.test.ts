/** The newsletter actions: honeypot, consent box, Origin, rate limit, an identical answer for every address, confirm. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildConfirmToken } from '@store/core/marketing';
import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
const state = vi.hoisted<{ origin: boolean; handle: unknown; calls: number }>(() => ({
  origin: true,
  handle: null,
  calls: 0,
}));

vi.mock('@/lib/admin/bound-action', () => ({
  requestOriginOk: () => Promise.resolve(state.origin),
}));
vi.mock('@/lib/admin/config', () => ({ authConfig: () => Promise.resolve({ secret: SECRET }) }));
vi.mock('@/lib/db', () => ({ getDb: () => Promise.resolve(state.handle) }));
vi.mock('@/lib/request-limits', () => ({
  limiters: { newsletter: {} },
  checkLimit: () => {
    state.calls += 1;
    return Promise.resolve({ allowed: state.calls <= 8, retryAfterSeconds: 60 });
  },
}));

const { subscribeNewsletterAction, confirmNewsletterAction } =
  await import('../src/actions/unsubscribe');

let testDb: TestDatabase;
let handle: DbHandle;
beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 2 });
  state.handle = handle.db;
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});
const count = async (table: string): Promise<number> =>
  (await handle.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ??
  -1;

describe('subscribeNewsletterAction', () => {
  it('a honeypot is a silent success that stores nothing; a missing box or a bad address is refused', async () => {
    expect(
      await subscribeNewsletterAction({
        email: 'bot@example.test',
        locale: 'uk',
        consent: true,
        website: 'x',
      }),
    ).toEqual({ status: 'sent' });
    expect(await count('newsletter_subscribers')).toBe(0);
    expect(
      await subscribeNewsletterAction({ email: 'a@example.test', locale: 'uk', consent: false }),
    ).toEqual({ status: 'error', code: 'consent' });
    expect(await subscribeNewsletterAction({ email: 'nope', locale: 'uk', consent: true })).toEqual(
      { status: 'error', code: 'invalid' },
    );
    state.origin = false;
    expect(
      await subscribeNewsletterAction({ email: 'a@example.test', locale: 'uk', consent: true }),
    ).toEqual({ status: 'error', code: 'invalid' });
    state.origin = true;
    expect(await count('newsletter_subscribers')).toBe(0);
  });

  it('a new address, a pending one and a subscribed one get the byte-identical answer', async () => {
    state.calls = 0;
    const input = { locale: 'uk' as const, consent: true };
    const fresh = JSON.stringify(
      await subscribeNewsletterAction({ ...input, email: 'a@example.test' }),
    );
    const pending = JSON.stringify(
      await subscribeNewsletterAction({ ...input, email: 'a@example.test' }),
    );
    const id =
      (await handle.pool.query<{ id: string }>(`SELECT id FROM newsletter_subscribers`)).rows[0]
        ?.id ?? '';
    expect(await confirmNewsletterAction({ token: buildConfirmToken(SECRET, id) })).toEqual({
      status: 'confirmed',
    });
    const subscribed = JSON.stringify(
      await subscribeNewsletterAction({ ...input, email: 'a@example.test' }),
    );
    expect(new Set([fresh, pending, subscribed]).size).toBe(1);
    expect(fresh).toBe('{"status":"sent"}');
  });

  it('is rate limited, and confirm refuses a forged token and a foreign Origin', async () => {
    state.calls = 100;
    expect(
      await subscribeNewsletterAction({ email: 'b@example.test', locale: 'uk', consent: true }),
    ).toEqual({ status: 'error', code: 'rateLimited' });
    state.calls = 0;
    const id = '00000000-0000-4000-8000-000000000001';
    expect(await confirmNewsletterAction({ token: `${buildConfirmToken(SECRET, id)}x` })).toEqual({
      status: 'error',
      code: 'invalid',
    });
    state.origin = false;
    expect(await confirmNewsletterAction({ token: buildConfirmToken(SECRET, id) })).toEqual({
      status: 'error',
      code: 'invalid',
    });
    state.origin = true;
  });
});
