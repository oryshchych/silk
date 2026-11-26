import { describe, expect, it } from 'vitest';

import { createSharedComputation } from './shared-computation';

function setup() {
  let calls = 0;
  let clock = 1_000;
  let release: () => void = () => undefined;
  let failNext = false;
  const shared = createSharedComputation(
    async () => {
      calls += 1;
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return calls;
    },
    { ttlMs: 60_000, minRefreshMs: 5_000, now: () => clock },
  );
  return {
    shared,
    calls: () => calls,
    tick: (ms: number) => {
      clock += ms;
    },
    finish: () => {
      release();
    },
    fail: () => {
      failNext = true;
    },
  };
}

describe('createSharedComputation', () => {
  it('ten parallel callers share ONE computation', async () => {
    const s = setup();
    const all = Promise.all(Array.from({ length: 10 }, () => s.shared.get(false)));
    await Promise.resolve();
    s.finish();
    const results = await all;
    expect(s.calls()).toBe(1);
    expect(new Set(results.map((r) => r.value)).size).toBe(1);
  });

  it('keeps the result for the ttl, then computes again', async () => {
    const s = setup();
    const first = s.shared.get(false);
    await Promise.resolve();
    s.finish();
    await first;
    s.tick(59_000);
    expect((await s.shared.get(false)).value).toBe(1);
    expect(s.calls()).toBe(1);
    s.tick(2_000);
    const second = s.shared.get(false);
    await Promise.resolve();
    s.finish();
    expect((await second).value).toBe(2);
  });

  it('a refresh is honoured only when the kept result is old enough', async () => {
    const s = setup();
    const first = s.shared.get(false);
    await Promise.resolve();
    s.finish();
    await first;
    s.tick(1_000);
    await s.shared.get(true);
    expect(s.calls()).toBe(1);
    s.tick(5_000);
    const refreshed = s.shared.get(true);
    await Promise.resolve();
    s.finish();
    expect((await refreshed).value).toBe(2);
  });

  it('a failure is not kept: the next caller tries again', async () => {
    const s = setup();
    s.fail();
    await expect(s.shared.get(false)).rejects.toThrow('boom');
    const retry = s.shared.get(false);
    await Promise.resolve();
    s.finish();
    expect((await retry).value).toBe(2);
  });
});
