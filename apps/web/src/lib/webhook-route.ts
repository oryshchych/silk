import { handlePaymentWebhook } from '@store/core/payments';

import { getDb } from './db';
import { errorReason } from './error-reason';
import { getPaymentProviders } from './payment-providers';
import { checkRequestLimit, limiters, requestClient } from './request-limits';
import { MAX_WEBHOOK_BYTES, readCappedBody } from './webhook-body';

const HEADERS = { 'Cache-Control': 'no-store' } as const;
const plain = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { ...HEADERS, ...headers } });

/**
 * The public edge of a payment webhook (ADR-4, `new-webhook` skill order):
 *  1. rate limit, per client AND over all clients, for EVERY method but OPTIONS, before anything
 *     is read (the limit is on the route, not on the verb);
 *  2. only POST; a size cap before the body is buffered;
 *  3. the raw BYTES go to core: signature before parsing, an unverified message to
 *     `webhook_quarantine` (bounded), the provider's own answer on every verified one.
 * A provider without credentials answers 503 and writes nothing: it fails closed, and the
 * provider redelivers later. Nothing from the request is logged except error classes.
 */
export async function handleWebhookRoute(
  code: 'mono' | 'wayforpay',
  request: Request,
): Promise<Response> {
  if (request.method === 'OPTIONS') return plain(405, { Allow: 'POST' });

  const perClient = await checkRequestLimit(limiters.webhook, request);
  const global = perClient.allowed ? limiters.webhookGlobal.check('all') : perClient;
  if (!global.allowed) return plain(429, { 'Retry-After': String(global.retryAfterSeconds) });

  if (request.method !== 'POST') return plain(405, { Allow: 'POST' });

  const adapter = (await getPaymentProviders())[code];
  if (adapter === undefined) return plain(503);

  const body = await readCappedBody(request, MAX_WEBHOOK_BYTES);
  if (!body.ok) return plain(413);

  try {
    const db = await getDb();
    const handled = await handlePaymentWebhook(
      {
        provider: adapter,
        runInTransaction: async (fn) => await db.transaction(async (tx) => await fn(tx)),
      },
      { rawBody: body.bytes, headers: request.headers, sourceIp: await requestClient(request) },
    );
    const response = new Response(handled.response.body, {
      status: handled.response.status,
      headers: handled.response.headers,
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    // A failure inside the handler (database down) is a 500: the provider redelivers.
    process.stderr.write(
      `${JSON.stringify({ level: 'error', scope: 'webhook', provider: code, reason: errorReason(error) })}\n`,
    );
    return plain(500);
  }
}
