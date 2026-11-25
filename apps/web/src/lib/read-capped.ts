/**
 * The request body as ONE Buffer, refused as soon as it passes the cap: the stream is CANCELLED at
 * that point, so a client that lies about (or leaves out) the length can never make the server
 * hold more than the cap. Memory: a declared length is trusted only as an upper bound (a body
 * longer than it is cut off), the buffer is allocated once from it, and chunks are copied in: no
 * list of chunks and no second copy at the end. Without a declared length the buffer grows by
 * doubling up to the cap. Returns `null` when the cap (or the declared length) was exceeded.
 */
export async function readCapped(request: Request, limit: number): Promise<Buffer | null> {
  if (request.body === null) return Buffer.alloc(0);
  const header = request.headers.get('content-length');
  const declared = header === null || header.trim() === '' ? Number.NaN : Number(header);
  const known = Number.isInteger(declared) && declared >= 0;
  if (known && declared > limit) return null;
  const cap = known ? declared : limit;
  let buffer = Buffer.allocUnsafe(known ? declared : Math.min(limit, 256 * 1024));
  let length = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.byteLength > cap) {
      await reader.cancel();
      return null;
    }
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
  return buffer.subarray(0, length);
}
