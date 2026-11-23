/**
 * A faithful local WayForPay: real HTTP at POST /api, requests and answers signed with the
 * documented HMAC_MD5 field lists. Used until merchant credentials exist (OWNER_QUEUE).
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const FAKE_ACCOUNT = 'test_merch_n1';
export const FAKE_SECRET = 'flk3409refn54t54t*FNJRET';

const md5 = (secret: string, fields: readonly string[]): string =>
  createHmac('md5', secret).update(fields.join(';'), 'utf8').digest('hex');

export interface FakeWayForPay {
  baseUrl: string;
  requests: { body: Record<string, unknown> }[];
  /** Payments by order reference; tests set the status the next CHECK_STATUS returns. */
  payments: Map<string, { amount: number; status: string; reasonCode: number }>;
  /** A callback body as WayForPay would send it, correctly signed. */
  callback: (fields: {
    orderReference: string;
    amount: number | string;
    transactionStatus: string;
    reasonCode?: number;
    authCode?: string;
    cardPan?: string;
    /** Unsigned extras (dates, fee): changing them must not matter. */
    extra?: Record<string, unknown>;
    secret?: string;
    account?: string;
  }) => string;
  onCreate: (
    handler: (body: Record<string, unknown>) => {
      status: number;
      json?: unknown;
      hang?: boolean;
      headers?: Record<string, string>;
    },
  ) => void;
  onRefund: (
    handler: (body: Record<string, unknown>) => { status: number; json?: unknown; hang?: boolean },
  ) => void;
  close: () => Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export async function startFakeWayForPay(): Promise<FakeWayForPay> {
  const requests: FakeWayForPay['requests'] = [];
  const payments: FakeWayForPay['payments'] = new Map();
  let createHandler: Parameters<FakeWayForPay['onCreate']>[0] = (body) => {
    const ref = String(body['orderReference']);
    payments.set(ref, { amount: Number(body['amount']), status: 'Created', reasonCode: 1100 });
    return {
      status: 200,
      json: { reason: 'Ok', reasonCode: 1100, invoiceUrl: `https://secure.example/invoice/${ref}` },
    };
  };
  let refundHandler: Parameters<FakeWayForPay['onRefund']>[0] = (body) => {
    const ref = String(body['orderReference']);
    const fields = [FAKE_ACCOUNT, ref, 'Refunded', '1100'];
    return {
      status: 200,
      json: {
        merchantAccount: FAKE_ACCOUNT,
        orderReference: ref,
        transactionStatus: 'Refunded',
        reason: 'Ok',
        reasonCode: 1100,
        merchantSignature: md5(FAKE_SECRET, fields),
      },
    };
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ body });
      const send = (
        status: number,
        json?: unknown,
        headers: Record<string, string> = {},
      ): boolean => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(json === undefined ? '' : JSON.stringify(json));
        return true;
      };
      if (req.url !== '/api' || req.method !== 'POST') return send(404);
      // The request signature is checked like the real service does.
      const type = body['transactionType'];
      const ref = String(body['orderReference']);
      let expected: string;
      if (type === 'CREATE_INVOICE') {
        const price = (body['productPrice'] as unknown[]).map(String);
        const names = (body['productName'] as unknown[]).map(String);
        const counts = (body['productCount'] as unknown[]).map(String);
        expected = md5(FAKE_SECRET, [
          String(body['merchantAccount']),
          String(body['merchantDomainName']),
          ref,
          String(body['orderDate']),
          String(body['amount']),
          String(body['currency']),
          ...names,
          ...counts,
          ...price,
        ]);
      } else if (type === 'CHECK_STATUS') {
        expected = md5(FAKE_SECRET, [String(body['merchantAccount']), ref]);
      } else if (type === 'REFUND') {
        expected = md5(FAKE_SECRET, [
          String(body['merchantAccount']),
          ref,
          String(body['amount']),
          String(body['currency']),
        ]);
      } else return send(400);
      if (body['merchantSignature'] !== expected) {
        return send(200, { reason: 'Invalid signature', reasonCode: 1129 });
      }
      if (type === 'CREATE_INVOICE') {
        const result = createHandler(body);
        if (result.hang === true) return;
        return send(result.status, result.json, result.headers);
      }
      if (type === 'REFUND') {
        const result = refundHandler(body);
        if (result.hang === true) return;
        return send(result.status, result.json);
      }
      const payment = payments.get(ref);
      if (payment === undefined) return send(200, { reason: 'Order not found', reasonCode: 1121 });
      const signed = {
        merchantAccount: FAKE_ACCOUNT,
        orderReference: ref,
        amount: payment.amount,
        currency: 'UAH',
        authCode: payment.status === 'Approved' ? '123456' : '',
        cardPan: '41****1111',
        transactionStatus: payment.status,
        reasonCode: payment.reasonCode,
      };
      send(200, {
        ...signed,
        reason: 'Ok',
        merchantSignature: md5(FAKE_SECRET, [
          signed.merchantAccount,
          signed.orderReference,
          String(signed.amount),
          signed.currency,
          signed.authCode,
          signed.cardPan,
          signed.transactionStatus,
          String(signed.reasonCode),
        ]),
      });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake wayforpay: no port');

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    payments,
    callback: (f) => {
      const account = f.account ?? FAKE_ACCOUNT;
      const authCode = f.authCode ?? (f.transactionStatus === 'Approved' ? '123456' : '');
      const cardPan = f.cardPan ?? '41****1111';
      const reasonCode = f.reasonCode ?? 1100;
      const signature = md5(f.secret ?? FAKE_SECRET, [
        account,
        f.orderReference,
        String(f.amount),
        'UAH',
        authCode,
        cardPan,
        f.transactionStatus,
        String(reasonCode),
      ]);
      return JSON.stringify({
        merchantAccount: account,
        orderReference: f.orderReference,
        merchantSignature: signature,
        amount: f.amount,
        currency: 'UAH',
        authCode,
        cardPan,
        transactionStatus: f.transactionStatus,
        reason: 'Ok',
        reasonCode,
        createdDate: 1_700_000_000,
        processingDate: 1_700_000_100,
        fee: 0.5,
        ...f.extra,
      });
    },
    onCreate: (handler) => {
      createHandler = handler;
    },
    onRefund: (handler) => {
      refundHandler = handler;
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
