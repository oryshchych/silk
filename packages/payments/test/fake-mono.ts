/**
 * A faithful local Mono: real HTTP, a real EC P-256 key pair, webhooks signed
 * exactly like the real service (ECDSA SHA-256 over the raw body, base64 DER
 * in X-Sign). Used until the owner provides a sandbox token.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface FakeMono {
  baseUrl: string;
  /** Signs a webhook body the way Mono does. */
  sign: (rawBody: string) => string;
  /** Requests received, for assertions. */
  requests: { method: string; url: string; body: string; token: string | undefined }[];
  /** Next create-invoice behaviour. */
  onCreate: (
    handler: (body: unknown) => { status: number; json?: unknown; hang?: boolean },
  ) => void;
  invoices: Map<string, Record<string, unknown>>;
  onCancel: (
    handler: (body: unknown) => { status: number; json?: unknown; hang?: boolean },
  ) => void;
  /** Merchant key rotation: signatures made before are no longer valid. */
  rotateKey: () => void;
  setPubkeyMode: (mode: 'ok' | 'garbage' | 'error' | 'rsa') => void;
  /** Restores the default create and cancel behaviour. */
  reset: () => void;
  close: () => Promise<void>;
  /** A second, unrelated key: signatures from it must not verify. */
  foreignSign: (rawBody: string) => string;
}

const referenceOf = (body: unknown): string => {
  if (typeof body === 'object' && body !== null && 'merchantPaymInfo' in body) {
    const info = body.merchantPaymInfo;
    if (typeof info === 'object' && info !== null && 'reference' in info) {
      if (typeof info.reference === 'string') return info.reference;
    }
  }
  return '';
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export async function startFakeMono(): Promise<FakeMono> {
  let pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const foreign = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pemOf = (): string => pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let pubkeyMode: 'ok' | 'garbage' | 'error' | 'rsa' = 'ok';
  const requests: FakeMono['requests'] = [];
  const invoices = new Map<string, Record<string, unknown>>();
  const defaultCreate: Parameters<FakeMono['onCreate']>[0] = (body) => {
    const reference = referenceOf(body);
    const invoiceId = `inv-${String(invoices.size + 1)}`;
    invoices.set(invoiceId, { invoiceId, status: 'created', reference });
    return { status: 200, json: { invoiceId, pageUrl: `https://pay.example/${invoiceId}` } };
  };
  const defaultCancel: Parameters<FakeMono['onCancel']>[0] = () => ({
    status: 200,
    json: { status: 'success' },
  });
  let createHandler = defaultCreate;
  let cancelHandler = defaultCancel;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const token = req.headers['x-token'];
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        token: typeof token === 'string' ? token : undefined,
      });
      const send = (status: number, json?: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/merchant/pubkey') {
        if (pubkeyMode === 'error') send(503);
        else if (pubkeyMode === 'garbage')
          send(200, { key: Buffer.from('not a key').toString('base64') });
        else if (pubkeyMode === 'rsa') {
          const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
          const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
          send(200, { key: Buffer.from(rsaPem).toString('base64') });
        } else send(200, { key: Buffer.from(pemOf()).toString('base64') });
      } else if (url.pathname === '/api/merchant/invoice/create') {
        const result = createHandler(JSON.parse(body));
        if (result.hang === true) return; // never answers: the client times out
        send(result.status, result.json);
      } else if (url.pathname === '/api/merchant/invoice/cancel') {
        const result = cancelHandler(JSON.parse(body));
        if (result.hang === true) return;
        send(result.status, result.json);
      } else if (url.pathname === '/api/merchant/invoice/status') {
        const invoice = invoices.get(url.searchParams.get('invoiceId') ?? '');
        if (invoice === undefined) send(404, { errText: 'not found' });
        else send(200, { amount: 129900, ccy: 980, ...invoice });
      } else {
        send(404);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake mono: no port');
  const { port } = address;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    sign: (raw) => sign('sha256', Buffer.from(raw), pair.privateKey).toString('base64'),
    foreignSign: (raw) => sign('sha256', Buffer.from(raw), foreign.privateKey).toString('base64'),
    requests,
    invoices,
    rotateKey: () => {
      pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    },
    setPubkeyMode: (mode) => {
      pubkeyMode = mode;
    },
    onCreate: (handler) => {
      createHandler = handler;
    },
    onCancel: (handler) => {
      cancelHandler = handler;
    },
    reset: () => {
      createHandler = defaultCreate;
      cancelHandler = defaultCancel;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
