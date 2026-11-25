import { describe, expect, it } from 'vitest';

import { readCapped } from './read-capped';

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
    expect(await readCapped(withLength(10_000_000, streamOf(1, 10)), 1_000)).toBeNull();
  });

  it('a body longer than its declared length is cut off at the declared length', async () => {
    expect(await readCapped(withLength(100, streamOf(5, 100)), 10_000)).toBeNull();
  });

  it('with a declared length the result is a view of ONE allocation of that size', async () => {
    const body = await readCapped(withLength(300, streamOf(3, 100)), 10_000);
    expect(body?.length).toBe(300);
    expect(body?.buffer.byteLength).toBeGreaterThanOrEqual(300);
  });
});

describe('readCapped', () => {
  it('returns a body within the cap whole', async () => {
    const body = await readCapped(requestOf(streamOf(3, 100)), 300);
    expect(body?.length).toBe(300);
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
    expect(await readCapped(requestOf(endless), 10 * 1024)).toBeNull();
    expect(cancelled).toBe(true);
  }, 5_000);

  it('an empty or missing body is an empty buffer', async () => {
    expect((await readCapped(requestOf(null), 100))?.length).toBe(0);
    expect((await readCapped(requestOf(streamOf(0, 1)), 100))?.length).toBe(0);
  });
});
