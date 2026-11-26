import { describe, expect, it, vi } from 'vitest';

import { canHaveRedirect, createRedirectMap } from './redirect-map';

const rows = [
  { fromPath: '/product/old', toPath: '/product/new', statusCode: 301 as const },
  { fromPath: '/en/category/old', toPath: '/en/category/new', statusCode: 302 as const },
];

describe('canHaveRedirect', () => {
  it('only product and category pages, in either locale', () => {
    for (const path of ['/product/a', '/en/product/a', '/category/a', '/en/category/a']) {
      expect(canHaveRedirect(path), path).toBe(true);
    }
    for (const path of [
      '/',
      '/search',
      '/admin',
      '/product/a/b',
      '/product/',
      '/api/health',
      '/uk/product/a',
    ]) {
      expect(canHaveRedirect(path), path).toBe(false);
    }
  });
});

describe('createRedirectMap', () => {
  it('serves a hit, answers null for a miss and for a path that cannot have a redirect without loading', async () => {
    const load = vi.fn(() => Promise.resolve(rows));
    const map = createRedirectMap(load);
    expect(await map.lookup('/product/old')).toEqual({ to: '/product/new', status: 301 });
    expect(await map.lookup('/en/category/old')).toEqual({ to: '/en/category/new', status: 302 });
    expect(await map.lookup('/product/none')).toBeNull();
    const calls = load.mock.calls.length;
    expect(await map.lookup('/search')).toBeNull();
    expect(load.mock.calls.length).toBe(calls);
  });

  it('loads once for concurrent first lookups (single flight)', async () => {
    const load = vi.fn(() => Promise.resolve(rows));
    const map = createRedirectMap(load);
    await Promise.all([
      map.lookup('/product/a'),
      map.lookup('/product/b'),
      map.lookup('/product/old'),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('invalidate makes the next lookup see a new table; a failed reload keeps the last good one', async () => {
    let table = [...rows];
    let fail = false;
    const clock = { t: 0 };
    const map = createRedirectMap(
      () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(table)),
      { now: () => clock.t, onError: () => undefined },
    );
    expect(await map.lookup('/product/fresh')).toBeNull();
    table = [
      ...rows,
      { fromPath: '/product/fresh', toPath: '/product/x', statusCode: 301 as const },
    ];
    map.invalidate();
    // The very next lookup waits for the fresh table: the change is served at once.
    expect(await map.lookup('/product/fresh')).toEqual({ to: '/product/x', status: 301 });
    fail = true;
    clock.t += 120_000;
    await map.lookup('/product/old');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await map.lookup('/product/old')).toEqual({ to: '/product/new', status: 301 });
  });

  it('an invalidation made by ANOTHER map instance (the server actions) reaches this one (the proxy)', async () => {
    let table = [...rows];
    const proxySide = createRedirectMap(() => Promise.resolve(table));
    const actionSide = createRedirectMap(() => Promise.resolve(table));
    expect(await proxySide.lookup('/product/fresh')).toBeNull();
    table = [
      ...rows,
      { fromPath: '/product/fresh', toPath: '/product/x', statusCode: 301 as const },
    ];
    actionSide.invalidate();
    expect(await proxySide.lookup('/product/fresh')).toEqual({ to: '/product/x', status: 301 });
  });

  it('answers null (fails open) until the first load succeeds', async () => {
    const map = createRedirectMap(() => Promise.reject(new Error('down')), {
      onError: () => undefined,
    });
    expect(await map.lookup('/product/old')).toBeNull();
  });
});

describe('createRedirectMap: 410 and hit counting', () => {
  const table = [
    { fromPath: '/product/old', toPath: '/product/new', statusCode: 301 as const },
    { fromPath: '/product/gone', toPath: '/', statusCode: 410 as const },
  ];

  it('serves a 410 row as a hit with status 410', async () => {
    const map = createRedirectMap(() => Promise.resolve(table));
    expect(await map.lookup('/product/gone')).toEqual({ to: '/', status: 410 });
  });

  it('counts only paths of the table, so counters cannot grow with client input', async () => {
    const flushHits = vi.fn<(hits: ReadonlyMap<string, number>) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const map = createRedirectMap(() => Promise.resolve(table), { flushHits, flushAt: 3 });
    await map.lookup('/product/old');
    for (let i = 0; i < 1000; i++) map.noteHit(`/product/random-${String(i)}`);
    expect(flushHits).not.toHaveBeenCalled();
    map.noteHit('/product/old');
    map.noteHit('/product/old');
    map.noteHit('/product/gone');
    await Promise.resolve();
    expect(flushHits).toHaveBeenCalledTimes(1);
    expect([...(flushHits.mock.calls[0]?.[0] ?? new Map())]).toEqual([
      ['/product/old', 2],
      ['/product/gone', 1],
    ]);
  });

  it('flushes on the timer, and keeps the counts when the write fails (retry on the timer only)', async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const written: [string, number][] = [];
      const flushHits = vi.fn((hits: ReadonlyMap<string, number>) => {
        if (fail) return Promise.reject(new Error('db down'));
        written.push(...hits);
        return Promise.resolve();
      });
      const map = createRedirectMap(() => Promise.resolve(table), {
        flushHits,
        flushMs: 1000,
        flushAt: 2,
        onError: () => undefined,
      });
      await map.lookup('/product/old');
      map.noteHit('/product/old');
      await vi.advanceTimersByTimeAsync(1000);
      expect(flushHits).toHaveBeenCalledTimes(1);
      // During the outage more hits do not trigger a query each.
      for (let i = 0; i < 20; i++) map.noteHit('/product/old');
      expect(flushHits.mock.calls.length).toBeLessThanOrEqual(2);
      fail = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(written.reduce((sum, [, n]) => sum + n, 0)).toBe(21);
    } finally {
      vi.useRealTimers();
    }
  });
});
