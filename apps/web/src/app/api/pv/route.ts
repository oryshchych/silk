import { recordProductView, viewSessionHash } from '@store/core/product-views';
import { z } from 'zod';

import { getDb } from '@/lib/db';
import { isSameOrigin } from '@/lib/admin/origin';
import { readCappedBody } from '@/lib/webhook-body';
import { checkRequestLimit, limiters, requestClient } from '@/lib/request-limits';
import { runtimeEnv } from '@/lib/runtime-env';

/**
 * `POST /api/pv` with `{"productId": "<uuid>"}`: counts one product page view for the anonymous
 * session of today (`@store/core/product-views`). Public and unauthenticated, so every step is
 * bounded: a same-site `Origin` (a browser on another site cannot make a visitor count), a body of at
 * most 256 bytes read with a cap, a per-client limit, a per-client DAILY cap on rows and a TOTAL cap on
 * rows written per minute (a botnet cannot fill the table; past a cap the view is dropped silently).
 * Only a row that was really written spends the daily and total caps. Any well-formed request, about
 * any product, gets the same empty 204 (a malformed, foreign-origin, oversized or too frequent one gets
 * 400, 403, 413 or 429), so the answer says nothing about whether the product exists or the view was written. Never cached; it does not touch the storefront cache: the
 * product page is static and a small client component calls this after it has loaded.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;
const MAX_BYTES = 256;
const bodySchema = z.strictObject({ productId: z.uuid() });
const reply = (status: number, extra: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { ...HEADERS, ...extra } });

/** Thrown inside the transaction to undo a row that a cap refuses (the count is rough; the table is bounded). */
class ViewDropped extends Error {}

export async function POST(request: Request): Promise<Response> {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!isSameOrigin(request.headers.get('origin'), host)) return reply(403);
  if (request.headers.get('sec-fetch-site') === 'cross-site') return reply(403);
  const verdict = await checkRequestLimit(limiters.views, request);
  if (!verdict.allowed) return reply(429, { 'Retry-After': String(verdict.retryAfterSeconds) });
  // A declared length over the cap is refused before anything is read, and the connection is closed.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return reply(413, { Connection: 'close' });
  const body = await readCappedBody(request, MAX_BYTES);
  if (!body.ok) return reply(413, { Connection: 'close' });
  let parsed;
  try {
    parsed = bodySchema.safeParse(JSON.parse(new TextDecoder().decode(body.bytes)));
  } catch {
    return reply(400);
  }
  if (!parsed.success) return reply(400);
  const secret = (await runtimeEnv()).AUTH_SECRET;
  // No secret configured: nothing is stored (a view is never worth an unkeyed hash of an address).
  if (secret === undefined) return reply(204);
  const client = await requestClient(request);
  const sessionHash = viewSessionHash(secret, {
    day: new Date().toISOString().slice(0, 10),
    client,
  });
  const db = await getDb();
  try {
    await db.transaction(async (tx) => {
      const written = await recordProductView(tx, {
        productId: parsed.data.productId,
        sessionHash,
      });
      // The caps are spent only by a row that was really written: a request for a missing or hidden
      // product, or a repeat, costs neither. A row a cap refuses is undone with the transaction.
      if (written && !limiters.viewsDaily.check(client).allowed) throw new ViewDropped();
      if (written && !limiters.viewsTotal.check('all').allowed) throw new ViewDropped();
    });
  } catch (error) {
    if (!(error instanceof ViewDropped)) throw error;
  }
  return reply(204);
}
