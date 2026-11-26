/**
 * The request body as ONE Buffer, refused as soon as it passes the cap, and bounded in TIME too:
 *  - size: the stream is CANCELLED at the cap, so a client that lies about (or leaves out) the
 *    length can never make the server hold more than the cap. A declared length is trusted only as
 *    an upper bound (a longer body is cut off); the buffer is allocated once from it and chunks are
 *    copied in (no chunk list, no second copy). Without a declared length it grows by doubling up
 *    to the cap;
 *  - time: no chunk for `idleMs`, or the whole body not in `totalMs`, ends the read and cancels the
 *    stream. A client that sends the headers and then nothing (or a trickle) cannot hold the
 *    caller's slot for longer than the deadline.
 */
export type ReadResult =
  { ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'timeout' | 'aborted' };

/**
 * A declared length over the cap, known from the headers alone: the caller refuses it BEFORE it takes
 * an in-flight slot or reads a byte.
 */
export function declaredTooLarge(request: Request, limit: number): boolean {
  const header = request.headers.get('content-length');
  if (header === null || header.trim() === '') return false;
  const declared = Number(header);
  return Number.isInteger(declared) && declared > limit;
}

export interface ReadLimits {
  limit: number;
  idleMs?: number;
  totalMs?: number;
}

export async function readCapped(request: Request, limits: ReadLimits): Promise<ReadResult> {
  const { limit, idleMs = 15_000, totalMs = 60_000 } = limits;
  if (request.body === null) return { ok: true, body: Buffer.alloc(0) };
  const header = request.headers.get('content-length');
  const declared = header === null || header.trim() === '' ? Number.NaN : Number(header);
  const known = Number.isInteger(declared) && declared >= 0;
  if (known && declared > limit) {
    void request.body.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }
  const cap = known ? declared : limit;
  let buffer = Buffer.allocUnsafe(known ? declared : Math.min(limit, 256 * 1024));
  let length = 0;
  const reader = request.body.getReader();
  const startedAt = performance.now();

  // `cancel()` is NOT awaited: on a real server a stalled client never lets it settle, and waiting
  // for it would defeat the very deadline that called it. The answer goes out at once.
  const stop = (reason: 'too_large' | 'timeout' | 'aborted'): ReadResult => {
    void reader.cancel().catch(() => undefined);
    return { ok: false, reason };
  };

  for (;;) {
    const left = totalMs - (performance.now() - startedAt);
    if (left <= 0) return stop('timeout');
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => {
          resolve('timeout');
        },
        Math.min(idleMs, left),
      );
    });
    let next: Awaited<ReturnType<typeof reader.read>> | 'timeout';
    try {
      next = await Promise.race([reader.read(), timedOut]);
    } catch {
      // The client went away mid-body (a reset or an abort): not a server fault, and the slot is freed by the caller.
      return stop('aborted');
    } finally {
      clearTimeout(timer);
    }
    if (next === 'timeout') return stop('timeout');
    if (next.done) break;
    const { value } = next;
    if (length + value.byteLength > cap) return stop('too_large');
    if (length + value.byteLength > buffer.length) {
      const grown = Buffer.allocUnsafe(
        Math.min(cap, Math.max(buffer.length * 2, length + value.byteLength)),
      );
      buffer.copy(grown, 0, 0, length);
      buffer = grown;
    }
    buffer.set(value, length);
    length += value.byteLength;
  }
  return { ok: true, body: buffer.subarray(0, length) };
}
