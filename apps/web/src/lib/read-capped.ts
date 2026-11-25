/**
 * The request body as a Buffer, refused as soon as it passes `limit` bytes: the stream is
 * CANCELLED at that point, so a client that lies about (or leaves out) the length can never make
 * the server buffer more than `limit` plus one chunk. Returns `null` when the cap was hit.
 */
export async function readCapped(request: Request, limit: number): Promise<Buffer | null> {
  if (request.body === null) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
