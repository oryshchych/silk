/**
 * Bounded reading of a provider answer. A provider (or whatever answers in its place) must not be
 * able to make us buffer an unbounded body: the answers we parse are a few hundred bytes.
 */
export const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export class ResponseTooLargeError extends Error {
  constructor() {
    super('provider response exceeds the size cap');
    this.name = 'ResponseTooLargeError';
  }
}

/** Reads an answer as text, stopping at the cap (`redirect: 'error'` is set by the callers). */
export async function readTextCapped(
  response: Response,
  maxBytes: number = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw new ResponseTooLargeError();
  if (response.body === null) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    // The stream yields bytes; anything else is not a provider answer.
    if (!(chunk instanceof Uint8Array)) throw new SyntaxError('unreadable provider response');
    total += chunk.byteLength;
    if (total > maxBytes) throw new ResponseTooLargeError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads and parses a JSON answer under the same cap. */
export async function readJsonCapped(
  response: Response,
  maxBytes: number = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<unknown> {
  return JSON.parse(await readTextCapped(response, maxBytes)) as unknown;
}
