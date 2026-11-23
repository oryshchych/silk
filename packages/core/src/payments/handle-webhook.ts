/**
 * The webhook edge, framework-free: bytes in, `Response` out. The route
 * handler only reads the body as bytes (`arrayBuffer()`) and calls this.
 *
 * Order (ADR-4): verify the signature on the raw bytes -> an unverified
 * message goes to `webhook_quarantine` (NEVER to payment_events, or garbage
 * with a real invoice id would take the idempotency key and the genuine
 * message would be dropped as a duplicate) -> apply in ONE transaction ->
 * answer in the provider's own format, on the duplicate branch too.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { webhookQuarantine } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import type { PaymentProvider } from '@store/payments/types';

import { applyPaymentWebhook, type WebhookOutcome } from './apply-webhook.ts';

export interface WebhookDeps {
  provider: PaymentProvider;
  /** Runs `fn` in a database transaction; supplied by the caller (core has no pool). */
  runInTransaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /**
   * Upper bound of rows kept in `webhook_quarantine` (default 5000). The route is public, so a
   * flood of garbage must not grow the table without bound; past the cap a refused message is
   * still answered 400 but no longer stored (the cleanup job frees room by age).
   */
  quarantineCap?: number;
  /**
   * Asked before an UNVERIFIED body is stored. The web edge answers false once too many refused
   * messages arrived in a window, so a flood of garbage costs the database nothing; a genuine
   * message never depends on it (it is verified, applied and answered whatever this says).
   */
  mayStoreUnverified?: () => boolean;
}

const DEFAULT_QUARANTINE_CAP = 5000;

export interface WebhookRequest {
  rawBody: Uint8Array;
  headers: Headers;
  sourceIp: string | null;
}

export interface WebhookHandled {
  response: Response;
  outcome: WebhookOutcome | { kind: 'unverified' } | { kind: 'too_large' };
}

/**
 * A provider callback is a few hundred bytes. Past this the message is refused BEFORE it is
 * parsed or verified (and not stored): the edge of every route, not only this one, is bounded.
 */
export const MAX_WEBHOOK_BODY_BYTES = 16 * 1024;

const KEPT_HEADERS = ['x-sign', 'content-type', 'user-agent'];
/** An unverified body is attacker-controlled: keep a hash and a short, sanitised prefix only. */
const UNVERIFIED_PREFIX_CHARS = 2048;

/** Postgres text cannot hold NUL; strip it instead of failing the request with a 500. */
const sanitise = (text: string): string => text.replaceAll('\u0000', '');

function describeUnverified(rawBody: Uint8Array): string {
  const hash = createHash('sha256').update(rawBody).digest('hex');
  const prefix = sanitise(
    Buffer.from(rawBody.subarray(0, UNVERIFIED_PREFIX_CHARS * 4)).toString('utf8'),
  );
  return `sha256:${hash} bytes:${String(rawBody.byteLength)}\n${prefix.slice(0, UNVERIFIED_PREFIX_CHARS)}`;
}

async function quarantine(
  deps: WebhookDeps,
  req: WebhookRequest,
  reason: string,
  stored: string,
  untrusted: boolean,
): Promise<void> {
  if (untrusted && deps.mayStoreUnverified?.() === false) return;
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers[name] = sanitise(value.slice(0, 512));
  }
  const cap = deps.quarantineCap ?? DEFAULT_QUARANTINE_CAP;
  await deps.runInTransaction(async (tx) => {
    const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(webhookQuarantine);
    if ((held?.n ?? 0) >= cap) {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', scope: 'webhook-quarantine', reason: 'cap reached, message not stored' })}\n`,
      );
      return;
    }
    await tx.insert(webhookQuarantine).values({
      provider: deps.provider.code,
      rawBody: stored,
      headers,
      reason,
      sourceIp: req.sourceIp,
    });
  });
}

export async function handlePaymentWebhook(
  deps: WebhookDeps,
  req: WebhookRequest,
): Promise<WebhookHandled> {
  if (req.rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return { response: new Response(null, { status: 413 }), outcome: { kind: 'too_large' } };
  }
  const verified = await deps.provider.verifyWebhook(req.rawBody, req.headers);
  if (verified === null) {
    await quarantine(
      deps,
      req,
      'signature or structure did not verify',
      describeUnverified(req.rawBody),
      true,
    );
    // Non-2xx on purpose: a genuine message refused during a key outage is redelivered.
    return { response: new Response(null, { status: 400 }), outcome: { kind: 'unverified' } };
  }

  const outcome = await deps.runInTransaction(
    async (tx) => await applyPaymentWebhook(tx, deps.provider.code, verified),
  );

  if (outcome.kind === 'unmatched') {
    // Authentic, so the provider's validated subset is stored, not the raw body (which can
    // carry card data the adapter deliberately drops).
    await quarantine(
      deps,
      req,
      'authentic message names no known payment attempt',
      JSON.stringify(verified.rawPayload),
      false,
    );
  }
  // A duplicate still gets the provider's own answer, or it retries for hours.
  const response =
    outcome.kind === 'duplicate'
      ? deps.provider.buildWebhookResponse({ duplicate: true, of: verified })
      : deps.provider.buildWebhookResponse(verified);
  return { response, outcome };
}
