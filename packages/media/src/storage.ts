/**
 * Object storage over the S3 API (Cloudflare R2), with AWS Signature V4 written out here: one PUT
 * and one DELETE do not justify a cloud SDK, and the signer is small enough to test against a
 * fake that VERIFIES the signature.
 *
 *  - Path-style URLs (`endpoint/bucket/key`), region `auto` (R2).
 *  - The endpoint must be https; plain http only for loopback (a local fake), like the payment
 *    adapters.
 *  - Object keys are built by the caller from UUIDs and fixed words; `assertSafeKey` refuses
 *    anything else (no traversal, no empty segment, no leading slash), so a file name can never
 *    become part of a key.
 *  - Errors name the operation and the status, never a URL with credentials or a response body.
 */
import { createHash, createHmac } from 'node:crypto';

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Test seam. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export class StorageError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

const KEY = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_.-]*)*$/;

export function assertSafeKey(key: string): void {
  if (!KEY.test(key) || key.length > 300 || key.includes('..')) {
    throw new StorageError('refused an unsafe object key', null);
  }
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The `Authorization` header and the headers it signs (exported for the fake and the tests). */
export function signRequest(input: {
  method: string;
  host: string;
  path: string;
  payloadHash: string;
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  date: Date;
}): { authorization: string; amzDate: string } {
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    input.method,
    input.path,
    '',
    ...names.map((name) => `${name}:${headers[name] ?? ''}`),
    '',
    names.join(';'),
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

/** `Content-Disposition` is stored with the object and served back with it (a download, never inline). */
export interface PutOptions {
  contentDisposition?: string;
  /** Overrides the default `public, max-age=31536000, immutable` (a draft must never be cached publicly). */
  cacheControl?: string;
}

export interface Storage {
  put: (key: string, body: Buffer, contentType: string, options?: PutOptions) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function createStorage(config: StorageConfig): Storage {
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && isLoopback(endpoint.hostname))
  ) {
    throw new StorageError('the storage endpoint must be https (http only for loopback)', null);
  }
  const region = config.region ?? 'auto';
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());

  async function send(
    method: 'PUT' | 'DELETE',
    key: string,
    body: Buffer | null,
    contentType: string | null,
    options: PutOptions = {},
  ) {
    assertSafeKey(key);
    const path = `/${[config.bucket, ...key.split('/')].map(encodeSegment).join('/')}`;
    const payload = body ?? Buffer.alloc(0);
    const extra: Record<string, string> = {};
    if (contentType !== null) {
      extra['content-type'] = contentType;
      extra['cache-control'] = options.cacheControl ?? 'public, max-age=31536000, immutable';
      if (options.contentDisposition !== undefined) {
        extra['content-disposition'] = options.contentDisposition;
      }
    }
    const { authorization, amzDate } = signRequest({
      method,
      host: endpoint.host,
      path,
      payloadHash: sha256(payload),
      headers: extra,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region,
      date: now(),
    });
    let response: Response;
    try {
      response = await doFetch(`${endpoint.origin}${path}`, {
        method,
        headers: {
          ...extra,
          'x-amz-content-sha256': sha256(payload),
          'x-amz-date': amzDate,
          authorization,
        },
        ...(body === null ? {} : { body: new Uint8Array(payload) }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch {
      throw new StorageError(`${method} to the storage failed (network)`, null);
    }
    // The answer's body is never read: release the connection.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new StorageError(
        `${method} to the storage answered ${String(response.status)}`,
        response.status,
      );
    }
  }

  return {
    put: async (key, body, contentType, options) => {
      await send('PUT', key, body, contentType, options);
    },
    remove: async (key) => {
      await send('DELETE', key, null, null);
    },
  };
}
