import { describe, expect, it } from 'vitest';

import { declaredTooLarge, readCapped } from './read-capped';

const streamOf = (chunks: number, size: number, onCancel?: () => void) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) controller.close();
      else {
        sent += 1;
        controller.enqueue(new Uint8Array(size));
      }
    },
    cancel() {
      onCancel?.();
    },
  });
};

const requestOf = (body: ReadableStream<Uint8Array> | null) =>
  new Request('http://localhost/upload', { method: 'POST', body, duplex: 'half' } as RequestInit);

describe('readCapped memory', () => {
  const withLength = (length: number, stream: ReadableStream<Uint8Array>) =>
    new Request('http://localhost/upload', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { 'content-length': String(length) },
    } as RequestInit);

  it('a declared length over the cap is refused outright', async () => {
    expect(await readCapped(withLength(10_000_000, streamOf(1, 10)), { limit: 1_000 })).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('a body longer than its declared length is cut off at the declared length', async () => {
    expect(await readCapped(withLength(100, streamOf(5, 100)), { limit: 10_000 })).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('with a declared length the result is a view of ONE allocation of that size', async () => {
    const result = await readCapped(withLength(300, streamOf(3, 100)), { limit: 10_000 });
    expect(result.ok && result.body.length).toBe(300);
    expect(result.ok && result.body.buffer.byteLength).toBeGreaterThanOrEqual(300);
  });
});

describe('readCapped time limits', () => {
  it('does NOT wait for cancel() to settle: a stream whose cancel never resolves still ends at the deadline', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: () => new Promise(() => undefined),
    });
    const started = performance.now();
    const result = await readCapped(requestOf(stalled), {
      limit: 1_000_000,
      idleMs: 100,
      totalMs: 5_000,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it('the same for the size cap: an over-long body with a cancel that never settles is refused at once', async () => {
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel: () => new Promise(() => undefined),
    });
    const result = await readCapped(requestOf(big), { limit: 4_096 });
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  }, 5_000);

  it('a body that sends nothing after the headers ends with a timeout and cancels the stream', async () => {
    let cancelled = false;
    const silent = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel() {
        cancelled = true;
      },
    });
    const started = performance.now();
    const result = await readCapped(requestOf(silent), {
      limit: 1_000_000,
      idleMs: 100,
      totalMs: 5_000,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(cancelled).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it('a trickle that never finishes ends at the total deadline even though every pause is short', async () => {
    const trickle = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(new Uint8Array(1));
      },
    });
    const result = await readCapped(requestOf(trickle), {
      limit: 1_000_000,
      idleMs: 1_000,
      totalMs: 300,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  }, 10_000);
});

describe('readCapped', () => {
  it('returns a body within the cap whole', async () => {
    const result = await readCapped(requestOf(streamOf(3, 100)), { limit: 300 });
    expect(result.ok && result.body.length).toBe(300);
  });

  it('refuses a body over the cap, cancels the stream and stops reading (an endless body cannot be buffered)', async () => {
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readCapped(requestOf(endless), { limit: 10 * 1024 })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(cancelled).toBe(true);
  }, 5_000);

  it('an empty or missing body is an empty buffer', async () => {
    const empty = await readCapped(requestOf(null), { limit: 100 });
    expect(empty.ok && empty.body.length).toBe(0);
    const none = await readCapped(requestOf(streamOf(0, 1)), { limit: 100 });
    expect(none.ok && none.body.length).toBe(0);
  });
});

describe('a client that vanishes mid-body, and a declared length over the cap', () => {
  it('a read that rejects is "aborted", not an unhandled error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      pull(controller) {
        controller.error(new Error('aborted'));
      },
    });
    const request = new Request('https://shop.example/x', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(await readCapped(request, { limit: 1024 })).toEqual({ ok: false, reason: 'aborted' });
  });

  it('declaredTooLarge reads the header only', () => {
    const make = (length: string | null): Request =>
      new Request('https://shop.example/x', {
        method: 'POST',
        headers: length === null ? {} : { 'Content-Length': length },
        body: 'x',
      });
    expect(declaredTooLarge(make('2000'), 1000)).toBe(true);
    expect(declaredTooLarge(make('1000'), 1000)).toBe(false);
  });
});
