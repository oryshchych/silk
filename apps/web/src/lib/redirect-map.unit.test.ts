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
