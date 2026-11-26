import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// The action wrapper reads the request (headers, cookies, the database); here those are controlled.
const state = vi.hoisted(() => ({
  origin: true,
  customer: null as null | Record<string, string>,
}));
vi.mock('../admin/bound-action', () => ({
  requestOriginOk: () => Promise.resolve(state.origin),
}));
vi.mock('./session', () => ({ currentCustomer: () => Promise.resolve(state.customer) }));
vi.mock('../db', () => ({
  getDb: () =>
    Promise.resolve({ transaction: async (fn: (tx: unknown) => Promise<unknown>) => await fn({}) }),
}));
vi.mock('../request-limits', () => ({
  checkLimit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
  currentClient: () => Promise.resolve('203.0.113.1'),
}));

import { customerAction } from './action';

const schema = z.object({ n: z.number() });
const failing = (code: string) => () => {
  throw Object.assign(new Error('x'), { code });
};

beforeEach(() => {
  state.origin = true;
  state.customer = { customerId: 'c', userId: 'u', email: 'a@b.c', sid: 's', locale: 'uk' };
});

describe('customerAction', () => {
  it('refuses a foreign Origin first, then a missing session, before the body is parsed or run', async () => {
    const run = vi.fn(() => Promise.resolve(1));
    state.origin = false;
    expect(await customerAction({ n: 1 }, schema, run)).toEqual({ ok: false, code: 'error' });
    state.origin = true;
    state.customer = null;
    expect(await customerAction('garbage', schema, run)).toEqual({
      ok: false,
      code: 'unauthorized',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('maps what the person caused to "invalid" and an unknown record to "notFound"; the rest is "error"', async () => {
    const codeOf = async (code: string) =>
      (
        await customerAction({ n: 1 }, schema, failing(code), {
          notFoundCodes: ['WISHLIST_NOT_FOUND'],
        })
      ).ok
        ? 'ok'
        : (
            (await customerAction({ n: 1 }, schema, failing(code), {
              notFoundCodes: ['WISHLIST_NOT_FOUND'],
            })) as { code: string }
          ).code;
    for (const code of [
      'ALERT_AVAILABLE',
      'ALERT_LIMIT',
      'WISHLIST_FULL',
      'ADDRESS_LIMIT',
      'CHECKOUT_X',
    ]) {
      expect(await codeOf(code), code).toBe('invalid');
    }
    expect(await codeOf('WISHLIST_NOT_FOUND')).toBe('notFound');
    expect(await codeOf('SOMETHING_ELSE')).toBe('error');
  });

  it('a bad input is "invalid" and the body never runs', async () => {
    const run = vi.fn(() => Promise.resolve(1));
    expect(await customerAction({ n: 'x' }, schema, run)).toEqual({ ok: false, code: 'invalid' });
    expect(run).not.toHaveBeenCalled();
  });
});
