import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rate-limit';

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

  it('refuses a NEW key when the table is full of live windows (fail closed), never evicting a live one', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    expect(limiter.check('victim', 0).allowed).toBe(true);
    expect(limiter.check('victim', 1).allowed).toBe(false);
    // An attacker rotating keys fills the table...
    limiter.check('k1', 2);
    limiter.check('k2', 3);
    expect(limiter.check('k3', 4).allowed).toBe(false);
    // ...and the blocked victim stays blocked (no eviction reset).
    expect(limiter.check('victim', 5).allowed).toBe(false);
  });

  it('frees room once windows expire, so a full table recovers by itself', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2 });
    limiter.check('a', 0);
    limiter.check('b', 1);
    expect(limiter.check('c', 2).allowed).toBe(false);
    expect(limiter.check('c', 1_500).allowed).toBe(true);
  });

  it('sweeps before refusing: a table full of EXPIRED windows lets a new client in', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('c', 30_000).allowed).toBe(true);
    expect(limiter.check('d', 30_001).allowed).toBe(true);
    // The periodic sweep at 60 000 removes only 'a'; the next one is a whole window away (120 000).
    expect(limiter.check('e', 60_000).allowed).toBe(true);
    // At 91 000 'c' and 'd' have expired, only 'e' is live, and the table still counts three keys.
    // Refusing 'f' here would lock a new client out for ~30 s while Retry-After says 60.
    expect(limiter.check('f', 91_000).allowed).toBe(true);
  });

  it('still refuses a new key while the full table holds live windows', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    limiter.check('a', 0);
    limiter.check('b', 1);
    expect(limiter.check('c', 5_000).allowed).toBe(false);
    expect(limiter.check('c', 30_000).allowed).toBe(false);
  });

  it('does not sweep on every refusal when the table is full of live windows', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    limiter.check('a', 0);
    limiter.check('b', 1);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++)
      expect(limiter.check(`n${String(i)}`, 500 + (i % 400)).allowed).toBe(false);
    // A full-table sweep per call would be quadratic; throttled to once a second it is a few scans.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('sweeps expired windows in batches, not on every request', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 10_000 });
    for (let i = 0; i < 5_000; i++) limiter.check(`k${String(i)}`, 0);
    const started = performance.now();
    for (let i = 0; i < 5_000; i++) limiter.check(`n${String(i)}`, 10_000 + i);
    // 5 000 calls with 5 000 expired windows to clear: one sweep, not 5 000 scans.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('uses the monotonic clock by default (no argument needed)', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });
});
