/**
 * A local S3-compatible server for tests (no real R2 credentials exist). It VERIFIES the AWS
 * Signature V4 of every request against the one secret it knows, so a signing bug fails a test
 * instead of passing against a fake that accepts anything.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { signRequest } from '../src/storage.ts';

export const FAKE_ACCESS_KEY = 'fake-access-key-id';
export const FAKE_SECRET_KEY = 'fake-secret-access-key-0123456789abcdef';
export const FAKE_BUCKET = 'media-test';

export interface FakeS3 {
  endpoint: string;
  objects: Map<
    string,
    { body: Buffer; contentType: string; cacheControl: string; contentDisposition: string }
  >;
  rejected: number;
  /** Every request that reached the server, signed or not. */
  requests: number;
  close: () => Promise<void>;
}

export async function startFakeS3(host = '127.0.0.1', listenOn = 0): Promise<FakeS3> {
  const objects: FakeS3['objects'] = new Map();
  const state = { rejected: 0, requests: 0 };
  const server: Server = createServer((req, res) => {
    state.requests += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://fake');
      const header = (name: string): string => {
        const value = req.headers[name];
        return typeof value === 'string' ? value : '';
      };
      const auth = header('authorization');
      const signed = /SignedHeaders=([^,]+),/.exec(auth)?.[1]?.split(';') ?? [];
      const headers = Object.fromEntries(
        signed
          .filter((name) => !['host', 'x-amz-content-sha256', 'x-amz-date'].includes(name))
          .map((name) => [name, header(name)]),
      );
      const amzDate = header('x-amz-date');
      const expected = signRequest({
        method: req.method ?? '',
        host: header('host'),
        path: url.pathname,
        payloadHash: createHash('sha256').update(body).digest('hex'),
        headers,
        accessKeyId: FAKE_ACCESS_KEY,
        secretAccessKey: FAKE_SECRET_KEY,
        region: 'auto',
        date: new Date(
          `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
        ),
      });
      if (
        header('x-amz-content-sha256') !== createHash('sha256').update(body).digest('hex') ||
        expected.authorization !== auth ||
        !url.pathname.startsWith(`/${FAKE_BUCKET}/`)
      ) {
        state.rejected += 1;
        res.writeHead(403).end();
        return;
      }
      const key = decodeURIComponent(url.pathname.slice(FAKE_BUCKET.length + 2));
      if (req.method === 'PUT') {
        objects.set(key, {
          body,
          contentType: header('content-type'),
          cacheControl: header('cache-control'),
          contentDisposition: header('content-disposition'),
        });
        res.writeHead(200).end();
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else {
        res.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(listenOn, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    objects,
    get rejected() {
      return state.rejected;
    },
    get requests() {
      return state.requests;
    },
    close: async () => {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
