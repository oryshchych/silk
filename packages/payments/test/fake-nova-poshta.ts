/**
 * A local Nova Poshta: real HTTP, the JSON envelope of API 2.0 (`success`, `data`, `errors`), and
 * the print URLs. Used until the owner provides a sandbox key (Q2): the app is pointed at it, never
 * at the real carrier. It rejects a wrong key like the real one and records what it received so a
 * test can prove the key never appears anywhere else.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const FAKE_NP_KEY = 'np-fake-api-key-5c1d9e';

export interface FakeNovaPoshta {
  baseUrl: string;
  printBaseUrl: string;
  /** Every API call received: model, method and the properties (the key is not kept). */
  calls: { model: string; method: string; properties: Record<string, unknown> }[];
  /** The next `InternetDocument/save` behaviour. */
  onSave: (handler: (properties: Record<string, unknown>) => FakeReply) => void;
  /** Documents created so far (ttn by our reference): proof that a lost answer still made one. */
  documents: Map<string, string>;
  printHits: string[];
  reset: () => void;
  close: () => Promise<void>;
}

export type FakeReply =
  | { kind: 'ok'; cost?: string }
  | { kind: 'error'; errors: string[] }
  /** The document IS created, but the answer never arrives (the connection hangs). */
  | { kind: 'created-but-hang' }
  | { kind: 'hang' }
  | { kind: 'http'; status: number }
  | { kind: 'garbage' }
  /** success but without the document fields. */
  | { kind: 'empty' };

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};

export async function startFakeNovaPoshta(): Promise<FakeNovaPoshta> {
  const calls: FakeNovaPoshta['calls'] = [];
  const documents = new Map<string, string>();
  const printHits: string[] = [];
  let counter = 0;
  const defaultSave = (): FakeReply => ({ kind: 'ok' });
  let saveHandler: (properties: Record<string, unknown>) => FakeReply = defaultSave;

  const ttnFor = (): string => `5900000000${String(++counter).padStart(4, '0')}`;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.startsWith('/orders/')) {
        const match =
          /^\/orders\/(printDocument|printMarking100x100)\/orders\[\]\/(\d+)\/type\/pdf\/apiKey\/(.+)$/.exec(
            decodeURIComponent(url),
          );
        if (match === null || match[3] !== FAKE_NP_KEY) {
          res.writeHead(403).end();
          return;
        }
        printHits.push(`${match[1] ?? ''}:${match[2] ?? ''}`);
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0x80]));
        return;
      }
      const body = record(JSON.parse((await readBody(req)) || '{}'));
      const model = typeof body['modelName'] === 'string' ? body['modelName'] : '';
      const method = typeof body['calledMethod'] === 'string' ? body['calledMethod'] : '';
      const properties = record(body['methodProperties']);
      calls.push({ model, method, properties });
      const send = (json: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (body['apiKey'] !== FAKE_NP_KEY) {
        send({ success: false, data: [], errors: ['API key is invalid'] });
        return;
      }
      if (model === 'Counterparty' && method === 'save') {
        send({
          success: true,
          data: [{ Ref: 'recipient-ref-1', ContactPerson: { data: [{ Ref: 'contact-ref-1' }] } }],
          errors: [],
        });
        return;
      }
      if (model === 'InternetDocument' && method === 'save') {
        const reply = saveHandler(properties);
        const reference =
          typeof properties['InfoRegClientBarcodes'] === 'string'
            ? properties['InfoRegClientBarcodes']
            : '';
        const create = (): string => {
          const ttn = ttnFor();
          documents.set(reference, ttn);
          return ttn;
        };
        switch (reply.kind) {
          case 'ok': {
            const ttn = create();
            send({
              success: true,
              data: [{ Ref: `doc-${ttn}`, IntDocNumber: ttn, CostOnSite: reply.cost ?? '70' }],
              errors: [],
            });
            return;
          }
          case 'error':
            send({ success: false, data: [], errors: reply.errors });
            return;
          case 'created-but-hang':
            create();
            return;
          case 'hang':
            return;
          case 'http':
            res.writeHead(reply.status).end();
            return;
          case 'garbage':
            res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>maintenance</html>');
            return;
          case 'empty':
            send({ success: true, data: [{}], errors: [] });
            return;
        }
      }
      send({ success: false, data: [], errors: ['unknown method'] });
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake NP did not start');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    baseUrl: `${origin}/v2.0/json/`,
    printBaseUrl: origin,
    calls,
    onSave: (handler) => {
      saveHandler = handler;
    },
    documents,
    printHits,
    reset: () => {
      saveHandler = defaultSave;
      documents.clear();
      calls.length = 0;
      printHits.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
