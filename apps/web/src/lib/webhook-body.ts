/** A provider callback is a few hundred bytes; anything near this is not one. */
export const MAX_WEBHOOK_BYTES = 16 * 1024;

export type CappedBody = { ok: true; bytes: Uint8Array } | { ok: false };

/**
 * Reads a request body as BYTES (a signature covers the exact bytes, so no text decoding), and
 * stops as soon as it passes the cap: an unauthenticated body must not be buffered or stored
 * without bound. A declared length over the cap is refused before anything is read.
 */
export async function readCappedBody(request: Request, maxBytes: number): Promise<CappedBody> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return { ok: false };
  if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
