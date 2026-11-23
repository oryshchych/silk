/**
 * A faithful local Checkbox: real HTTP, bearer sign-in, a shift that must be open, receipts with a
 * client-chosen id that become DONE (with a fiscal code) after a configurable number of reads.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const FAKE_LICENSE = 'fake-license-key';
export const FAKE_LOGIN = 'cashier';
export const FAKE_PASSWORD = 'cashier-password';

export interface FakeReceipt {
  body: Record<string, unknown>;
  status: 'CREATED' | 'DONE' | 'ERROR';
  fiscalCode: string | null;
  reads: number;
}

export interface FakeCheckbox {
  baseUrl: string;
  receipts: Map<string, FakeReceipt>;
  state: { shiftOpen: boolean; shiftsOpened: number; signIns: number };
  /** Reads before a receipt turns DONE (0: immediately). */
  settleAfterReads: { value: number };
  /** Force the next POST /receipts/sell to answer this (and not store the receipt unless `store`). */
  failNextSell: (answer: { status: number; hang?: boolean; store?: boolean } | null) => void;
  /** Make the next call to this exact path answer this status (once). */
  failPathOnce: (path: string, status: number, headers?: Record<string, string>) => void;
  /** Requests that reached /leak (a redirect target): must stay empty. */
  leaks: string[];
  expireToken: () => void;
  close: () => Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export async function startFakeCheckbox(): Promise<FakeCheckbox> {
  const receipts = new Map<string, FakeReceipt>();
  const state = { shiftOpen: false, shiftsOpened: 0, signIns: 0 };
  const settleAfterReads = { value: 0 };
  let token = 'token-0';
  let nextSell: { status: number; hang?: boolean; store?: boolean } | null = null;
  let serial = 1000;
  const failures = new Map<string, { status: number; headers: Record<string, string> }>();
  const leaks: string[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const send = (status: number, json?: unknown): boolean => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
        return true;
      };
      const path = req.url ?? '';
      if (req.headers['x-license-key'] !== FAKE_LICENSE) return send(403, { message: 'licence' });
      if (path === '/leak') {
        leaks.push(req.headers['x-license-key'] ?? '');
        return send(200, {});
      }
      const forced = failures.get(path);
      if (forced !== undefined) {
        failures.delete(path);
        res.writeHead(forced.status, { 'Content-Type': 'application/json', ...forced.headers });
        res.end('{}');
        return true;
      }
      if (path === '/cashier/signin' && req.method === 'POST') {
        const body = JSON.parse(raw) as Record<string, unknown>;
        if (body['login'] !== FAKE_LOGIN || body['password'] !== FAKE_PASSWORD) return send(403);
        state.signIns += 1;
        token = `token-${String(state.signIns)}`;
        return send(200, { access_token: token });
      }
      if (req.headers['authorization'] !== `Bearer ${token}`) return send(401);
      if (path === '/cashier/shift' && req.method === 'GET') {
        return state.shiftOpen ? send(200, { status: 'OPENED' }) : send(200, null);
      }
      if (path === '/shifts' && req.method === 'POST') {
        state.shiftOpen = true;
        state.shiftsOpened += 1;
        return send(202, { status: 'CREATED' });
      }
      if (path === '/receipts/sell' && req.method === 'POST') {
        if (!state.shiftOpen) return send(400, { message: 'shift is closed' });
        const body = JSON.parse(raw) as Record<string, unknown>;
        const id = String(body['id']);
        const forced = nextSell;
        nextSell = null;
        const store = (): void => {
          if (receipts.has(id)) return;
          serial += 1;
          receipts.set(id, {
            body,
            status: 'CREATED',
            fiscalCode: `FN${String(serial)}`,
            reads: 0,
          });
        };
        if (forced !== null) {
          if (forced.store === true) store();
          if (forced.hang === true) return;
          return send(forced.status, { message: 'forced' });
        }
        if (receipts.has(id)) return send(409, { message: 'receipt exists' });
        const payments = body['payments'] as { value: number }[];
        const goods = body['goods'] as { good: { price: number }; quantity: number }[];
        const goodsTotal = goods.reduce((t, g) => t + (g.good.price * g.quantity) / 1000, 0);
        if (payments.reduce((t, p) => t + p.value, 0) !== goodsTotal) {
          return send(422, { message: 'payments do not match goods' });
        }
        store();
        return send(201, { id, status: 'CREATED' });
      }
      const match = /^\/receipts\/([^/]+)$/.exec(path);
      if (match?.[1] !== undefined && req.method === 'GET') {
        const receipt = receipts.get(decodeURIComponent(match[1]));
        if (receipt === undefined) return send(404);
        receipt.reads += 1;
        if (receipt.status === 'CREATED' && receipt.reads > settleAfterReads.value) {
          receipt.status = 'DONE';
        }
        return send(200, {
          id: decodeURIComponent(match[1]),
          status: receipt.status,
          fiscal_code: receipt.status === 'DONE' ? receipt.fiscalCode : null,
        });
      }
      send(404);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake checkbox: no port');

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    receipts,
    state,
    settleAfterReads,
    failNextSell: (answer) => {
      nextSell = answer;
    },
    failPathOnce: (path, status, headers = {}) => {
      failures.set(path, { status, headers });
    },
    leaks,
    expireToken: () => {
      token = 'expired-elsewhere';
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
