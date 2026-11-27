/**
 * The newsletter actions: honeypot, consent box, Origin, the four rate limits (client, global, domain, canonical
 * mailbox), an identical answer for every address, and confirm. The limiters are the real ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConfirmToken } from '@store/core/marketing';
import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
const state = vi.hoisted<{
  origin: boolean;
  handle: unknown;
  client: string;
  fresh: () => void;
}>(() => ({ origin: true, handle: null, client: 'c0', fresh: () => undefined }));

vi.mock('@/lib/admin/bound-action', () => ({
  requestOriginOk: () => Promise.resolve(state.origin),
}));
vi.mock('@/lib/admin/config', () => ({ authConfig: () => Promise.resolve({ secret: SECRET }) }));
vi.mock('@/lib/db', () => ({ getDb: () => Promise.resolve(state.handle) }));
vi.mock('@/lib/request-limits', async () => {
  const { createRateLimiter } = await import('@/lib/rate-limit');
  const make = () => ({
    newsletter: createRateLimiter({ limit: 5, windowMs: 600_000 }),
    newsletterGlobal: createRateLimiter({ limit: 300, windowMs: 60_000, maxKeys: 1 }),
    newsletterDomain: createRateLimiter({ limit: 60, windowMs: 600_000 }),
    newsletterMailbox: createRateLimiter({ limit: 3, windowMs: 3_600_000 }),
  });
  const limiters = make();
  state.fresh = () => Object.assign(limiters, make());
  return {
    limiters,
    checkLimit: (limiter: { check: (key: string) => unknown }) =>
      Promise.resolve(limiter.check(state.client)),
  };
});

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
beforeEach(() => {
  state.fresh();
  state.client = 'c0';
  state.origin = true;
});
const count = async (table: string): Promise<number> =>
  (await handle.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ??
  -1;
const ask = async (email: string, extra: Record<string, unknown> = {}) =>
  await subscribeNewsletterAction({ email, locale: 'uk', consent: true, ...extra });

describe('subscribeNewsletterAction', () => {
  it('a honeypot is a silent success that stores nothing; a missing box or a bad address is refused', async () => {
    const before = await count('newsletter_subscribers');
    expect(await ask('bot@example.test', { website: 'x' })).toEqual({ status: 'sent' });
    expect(await ask('a@example.test', { consent: false })).toEqual({
      status: 'error',
      code: 'consent',
    });
    expect(await ask('nope')).toEqual({ status: 'error', code: 'invalid' });
    state.origin = false;
    expect(await ask('a@example.test')).toEqual({ status: 'error', code: 'invalid' });
    expect(await count('newsletter_subscribers')).toBe(before);
  });

  it('a new address, a pending one and a subscribed one get the byte-identical answer', async () => {
    const fresh = JSON.stringify(await ask('same@example.test'));
    state.fresh();
    const pending = JSON.stringify(await ask('same@example.test'));
    const row = (
      await handle.pool.query<{ id: string; nonce: string }>(
        `SELECT id, request_nonce::text AS nonce FROM newsletter_subscribers WHERE email = 'same@example.test'`,
      )
    ).rows[0];
    expect(
      await confirmNewsletterAction({
        token: buildConfirmToken(SECRET, row?.id ?? '', row?.nonce ?? ''),
      }),
    ).toEqual({ status: 'confirmed' });
    state.fresh();
    const subscribed = JSON.stringify(await ask('same@example.test'));
    expect(new Set([fresh, pending, subscribed]).size).toBe(1);
    expect(fresh).toBe('{"status":"sent"}');
  });

  it('the client cap refuses the sixth request, even an invalid one (every attempt is metered)', async () => {
    for (let i = 0; i < 5; i += 1) await ask(`user${String(i)}@example.test`);
    expect(await ask('nope')).toEqual({ status: 'error', code: 'rateLimited' });
  });

  it('the canonical mailbox cap: victim+1 to victim+3 pass, victim+4 and victim@ are refused', async () => {
    for (const tag of ['+1', '+2', '+3']) {
      state.client = `m${tag}`;
      expect(await ask(`victim${tag}@example.test`)).toEqual({ status: 'sent' });
    }
    state.client = 'm-other';
    expect(await ask('victim+4@example.test')).toEqual({ status: 'error', code: 'rateLimited' });
    expect(await ask('Victim@example.test')).toEqual({ status: 'error', code: 'rateLimited' });
    expect(await count('newsletter_subscribers')).toBeGreaterThanOrEqual(3);
  });

  it('the domain cap refuses the 61st address of one domain from rotating clients', async () => {
    for (let i = 0; i < 60; i += 1) {
      state.client = `d${String(i)}`;
      expect(await ask(`person${String(i)}@bulk.test`)).toEqual({ status: 'sent' });
    }
    state.client = 'd-last';
    expect(await ask('person61@bulk.test')).toEqual({ status: 'error', code: 'rateLimited' });
  });

  it('the global cap refuses the 301st request in a minute from 301 different clients', async () => {
    for (let i = 0; i < 300; i += 1) {
      state.client = `g${String(i)}`;
      expect((await ask(`g${String(i)}@host${String(i % 250)}.test`)).status).not.toBe('error');
    }
    state.client = 'g-last';
    expect(await ask('last@host-last.test')).toEqual({ status: 'error', code: 'rateLimited' });
  });
});

describe('confirmNewsletterAction', () => {
  it('refuses a forged token and a foreign Origin', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const nonce = '00000000-0000-4000-8000-000000000002';
    expect(
      await confirmNewsletterAction({ token: `${buildConfirmToken(SECRET, id, nonce)}x` }),
    ).toEqual({ status: 'error', code: 'invalid' });
    state.origin = false;
    expect(await confirmNewsletterAction({ token: buildConfirmToken(SECRET, id, nonce) })).toEqual({
      status: 'error',
      code: 'invalid',
    });
  });
});
