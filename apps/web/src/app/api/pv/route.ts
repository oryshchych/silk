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
 * most 256 bytes read with a cap, a per-client limit and a TOTAL cap on rows written per minute (a
 * botnet cannot fill the table; past it the view is dropped silently and the answer is the same).
 * The answer is always an empty 204 for a well-formed request, so it says nothing about whether the
 * product exists or the view was written. Never cached; it does not touch the storefront cache: the
 * product page is static and a small client component calls this after it has loaded.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;
const MAX_BYTES = 256;
const bodySchema = z.strictObject({ productId: z.uuid() });
const reply = (status: number, extra: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { ...HEADERS, ...extra } });

export async function POST(request: Request): Promise<Response> {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!isSameOrigin(request.headers.get('origin'), host)) return reply(403);
  const verdict = await checkRequestLimit(limiters.views, request);
  if (!verdict.allowed) return reply(429, { 'Retry-After': String(verdict.retryAfterSeconds) });
  const body = await readCappedBody(request, MAX_BYTES);
  if (!body.ok) return reply(413);
  let parsed;
  try {
    parsed = bodySchema.safeParse(JSON.parse(new TextDecoder().decode(body.bytes)));
  } catch {
    return reply(400);
  }
  if (!parsed.success) return reply(400);
  // A bounded table: past the total cap the view is dropped, not stored (the count is a rough one).
  if (!limiters.viewsTotal.check('all').allowed) return reply(204);
  const secret = (await runtimeEnv()).AUTH_SECRET;
  // No secret configured: nothing is stored (a view is never worth an unkeyed hash of an address).
  if (secret === undefined) return reply(204);
  const sessionHash = viewSessionHash(secret, {
    day: new Date().toISOString().slice(0, 10),
    client: await requestClient(request),
    userAgent: request.headers.get('user-agent') ?? '',
  });
  const db = await getDb();
  await db.transaction(async (tx) => {
    await recordProductView(tx, { productId: parsed.data.productId, sessionHash });
  });
  return reply(204);
}
