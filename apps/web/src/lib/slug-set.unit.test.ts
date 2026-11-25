import { describe, expect, it, vi } from 'vitest';

import { createSlugSet } from './slug-set';

describe('createSlugSet invalidation', () => {
  it('after invalidate() the NEXT lookup waits for a fresh set (a publish or a rename is served at once)', async () => {
    let list = ['a'];
    const set = createSlugSet(() => Promise.resolve(list), { ttlMs: 60_000 });
    expect(await set.has('b')).toBe(false);
    list = ['a', 'b'];
    set.invalidate();
    expect(await set.has('b')).toBe(true);
  });

  it('an invalidation made through another instance (the server actions) reaches this one (the proxy)', async () => {
    let list = ['a'];
    const proxySide = createSlugSet(() => Promise.resolve(list), { ttlMs: 60_000 });
    const actionSide = createSlugSet(() => Promise.resolve(list), { ttlMs: 60_000 });
    expect(await proxySide.has('b')).toBe(false);
    list = ['a', 'b'];
    actionSide.invalidate();
    expect(await proxySide.has('b')).toBe(true);
  });
});

describe('createSlugSet', () => {
  it('answers from the loaded set and picks up a changed set after the TTL', async () => {
    let clock = 0;
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['a'])
      .mockResolvedValueOnce(['a', 'b']);
    const set = createSlugSet(load, { ttlMs: 1_000, now: () => clock });
    expect(await set.has('a')).toBe(true);
    expect(await set.has('b')).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    clock = 1_000;
    // Served from the old set while the refresh runs; the next answer has the new one.
    expect(await set.has('b')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await set.has('b')).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('backs off after repeated failures and starts over after a success', async () => {
    let clock = 0;
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(['a'])
      .mockRejectedValue(new Error('down'));
    const set = createSlugSet(load, { ttlMs: 60_000, now: () => clock });
    await set.has('a'); // failure 1: next try in 5 s
    clock = 4_999;
    await set.has('a');
    expect(load).toHaveBeenCalledTimes(1);
    clock = 5_000;
    await set.has('a'); // failure 2: next try in 10 s
    clock = 14_999;
    await set.has('a');
    expect(load).toHaveBeenCalledTimes(2);
    clock = 15_000;
    await set.has('a'); // failure 3: next try in 20 s
    clock = 34_999;
    await set.has('a');
    expect(load).toHaveBeenCalledTimes(3);
    clock = 35_000;
    expect(await set.has('a')).toBe(true); // success resets the back-off
    clock = 95_000;
    await set.has('a'); // stale set served at once, refresh fails: back to 5 s
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock = 100_001;
    await set.has('a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).toHaveBeenCalledTimes(6);
  });

  it('shares one load between concurrent callers', async () => {
    let release: (value: string[]) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const set = createSlugSet(load);
    const answers = Promise.all([set.has('a'), set.has('x'), set.has('a')]);
    release(['a']);
    expect(await answers).toEqual([true, false, true]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves the stale set at once and refreshes in the background once a good set exists', async () => {
    let clock = 0;
    let release: (value: string[]) => void = () => undefined;
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['a'])
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            release = resolve;
          }),
      );
    const set = createSlugSet(load, { ttlMs: 1_000, now: () => clock });
    expect(await set.has('a')).toBe(true);
    clock = 1_500;
    // The refresh is pending, yet the answer comes immediately from the old set.
    expect(await set.has('a')).toBe(true);
    expect(await set.has('b')).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    release(['a', 'b']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await set.has('b')).toBe(true);
  });

  it('reports a failed refresh and keeps the last good set (stale-on-error)', async () => {
    let clock = 0;
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['a'])
      .mockRejectedValue(new Error('db down'));
    const reported: unknown[] = [];
    const set = createSlugSet(load, {
      ttlMs: 1_000,
      now: () => clock,
      onError: (error) => reported.push(error),
    });
    expect(await set.has('a')).toBe(true);
    clock = 1_500;
    expect(await set.has('a')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await set.has('zzz')).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it('answers null when nothing could ever be loaded, and does not retry on every call', async () => {
    let clock = 0;
    const load = vi.fn<() => Promise<string[]>>().mockRejectedValue(new Error('db down'));
    const set = createSlugSet(load, { ttlMs: 60_000, now: () => clock });
    expect(await set.has('a')).toBeNull();
    expect(await set.has('a')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    clock = 6_000;
    expect(await set.has('a')).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
