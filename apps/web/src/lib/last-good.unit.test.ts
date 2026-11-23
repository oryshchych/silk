import { describe, expect, it, vi } from 'vitest';

import { createLastGood } from './last-good';

describe('createLastGood', () => {
  it('returns the loaded value and remembers it per key', async () => {
    const run = createLastGood<string[]>();
    const onError = vi.fn();
    expect(await run('a', () => Promise.resolve(['x']), { fallback: [], onError })).toEqual(['x']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('serves the last good value for that key when the loader fails, and reports the failure', async () => {
    const run = createLastGood<string[]>();
    const onError = vi.fn();
    await run('a', () => Promise.resolve(['x']), { fallback: [], onError });
    await run('b', () => Promise.resolve(['y']), { fallback: [], onError });
    const failing = (): Promise<string[]> => Promise.reject(new Error('db flap'));
    expect(await run('a', failing, { fallback: [], onError })).toEqual(['x']);
    expect(await run('b', failing, { fallback: [], onError })).toEqual(['y']);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('falls back to the caller fallback when nothing was ever loaded for the key', async () => {
    const run = createLastGood<string[]>();
    const failing = (): Promise<string[]> => Promise.reject(new Error('down'));
    expect(await run('never', failing, { fallback: ['f'], onError: vi.fn() })).toEqual(['f']);
  });
});
