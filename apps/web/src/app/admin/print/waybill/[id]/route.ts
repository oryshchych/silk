import { can } from '@store/core/auth-permissions';
import { orderWaybillNumber } from '@store/core/waybill';
import { isWaybillNumber } from '@store/payments/shipping';
import { z } from 'zod';

import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { createRateLimiter } from '@/lib/rate-limit';
import { getWaybillCarrier } from '@/lib/waybill-carrier';

/**
 * `GET /admin/print/waybill/<order id>?kind=document|marking`: the printable waybill or its
 * sticker, fetched from the carrier on the SERVER. The carrier's print URL carries the API key, so
 * the browser is never given it: this route checks a full admin session read from the database and
 * the `orders.waybill` permission (a GET has no Origin; the cookie is `SameSite=Strict`), reads the
 * waybill number from the order (never from the request), and streams the PDF. `private, no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ limit: 60, windowMs: 10 * 60_000 });
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  // A relayed file is never sniffed into something else, and never runs script in this origin.
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'sandbox',
};
const refuse = (status: number, code: string): Response =>
  Response.json({ ok: false, code }, { status, headers: HEADERS });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return refuse(401, 'UNAUTHENTICATED');
  const { session } = resolved;
  if (!can(session.role, 'orders.waybill')) return refuse(403, 'FORBIDDEN');
  if (!limiter.check(session.userId).allowed) return refuse(429, 'RATE_LIMITED');

  const id = z.uuid().safeParse((await context.params).id);
  const kind = z
    .enum(['document', 'marking'])
    .safeParse(new URL(request.url).searchParams.get('kind'));
  if (!id.success || !kind.success) return refuse(400, 'INVALID_INPUT');

  const ttn = await orderWaybillNumber(await getDb(), id.data);
  if (ttn === null || !isWaybillNumber(ttn)) return refuse(404, 'NOT_FOUND');
  const carrier = await getWaybillCarrier();
  if (carrier === null) return refuse(503, 'WAYBILL_NOT_CONFIGURED');
  const pdf = await carrier.print(ttn, kind.data);
  if (pdf === null) return refuse(502, 'CARRIER_UNAVAILABLE');
  return new Response(new Uint8Array(pdf), {
    headers: {
      ...HEADERS,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${ttn}-${kind.data}.pdf"`,
    },
  });
}
