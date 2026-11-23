import { describe, expect, it } from 'vitest';

import { clientKey, createRateLimiter } from './rate-limit';

describe('createRateLimiter', () => {
  it('allows up to the limit in a window and blocks the rest with a retry time', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect([1, 2, 3].map(() => limiter.check('a', 1_000).allowed)).toEqual([true, true, true]);
    expect(limiter.check('a', 1_000)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.check('a', 31_000)).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it('starts a new window after the old one ends', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 500).allowed).toBe(false);
    expect(limiter.check('a', 1_000).allowed).toBe(true);
  });

  it('counts clients separately', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('b', 0).allowed).toBe(true);
    expect(limiter.check('a', 1).allowed).toBe(false);
  });

  it('bounds memory: dropping expired windows first, then the oldest key', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2 });
    limiter.check('a', 0);
    limiter.check('b', 10);
    limiter.check('c', 20);
    // 'a' was evicted to make room, so it starts fresh instead of being blocked.
    expect(limiter.check('a', 30).allowed).toBe(true);
  });
});

describe('clientKey', () => {
  it('takes the first forwarded address, trimmed', () => {
    expect(clientKey('203.0.113.7, 10.0.0.1')).toBe('203.0.113.7');
    expect(clientKey(' 198.51.100.2 ')).toBe('198.51.100.2');
  });

  it('falls back to unknown', () => {
    expect(clientKey(null)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
  });
});
