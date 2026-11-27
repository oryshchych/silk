import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ forwarded: '203.0.113.1', token: 'a'.repeat(32), calls: 0 }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ 'x-forwarded-for': state.forwarded })),
  cookies: () => Promise.resolve({ get: () => undefined }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/runtime-env', () => ({
  runtimeEnv: () => Promise.resolve({ TRUSTED_PROXY_HOPS: 1, APP_ENV: 'local' }),
}));
vi.mock('@/lib/cart-cookie', () => ({
  readCartToken: () => Promise.resolve(state.token),
  mintCartToken: vi.fn(),
  readOrderAccess: vi.fn(),
  setCartCount: vi.fn(),
  setOrderAccess: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  getDb: () =>
    Promise.resolve({
      transaction: () => {
        state.calls += 1;
        return Promise.reject(new Error('no database in this test'));
      },
    }),
}));
vi.mock('@/lib/pay', () => ({ beginCardPayment: vi.fn() }));

const { quoteAction } = await import('../src/actions/checkout');

beforeEach(() => {
  state.calls = 0;
});

describe('promo guessing is limited per cart session (PROMO_CODES.md section 6)', () => {
  it('31 distinct codes from one cart with a different address each: the 31st is refused', async () => {
    const results: { ok: boolean; code?: string }[] = [];
    for (let n = 1; n <= 31; n += 1) {
      state.forwarded = `198.51.100.${String(n)}`;
      results.push(
        await quoteAction({ locale: 'uk', delivery: 'pickup', promoCode: `ROT${String(n)}` }),
      );
    }
    expect(results.slice(0, 30).every((r) => r.code !== 'RATE_LIMITED')).toBe(true);
    expect(results[30]?.code).toBe('RATE_LIMITED');
    // The refused call never reached the database.
    expect(state.calls).toBe(30);
  });

  it('a quote without a code does not spend the budget, and another cart has its own', async () => {
    state.token = 'b'.repeat(32);
    for (let n = 1; n <= 40; n += 1) {
      state.forwarded = `198.51.101.${String(n)}`;
      const result = await quoteAction({ locale: 'uk', delivery: 'pickup' });
      expect(!result.ok && result.code).not.toBe('RATE_LIMITED');
    }
    state.token = 'c'.repeat(32);
    state.forwarded = '198.51.102.1';
    const first = await quoteAction({ locale: 'uk', delivery: 'pickup', promoCode: 'ONE' });
    expect(!first.ok && first.code).not.toBe('RATE_LIMITED');
  });
});
