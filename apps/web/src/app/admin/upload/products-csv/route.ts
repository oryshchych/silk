import { CSV_LIMITS } from '@store/core/admin-csv';
import { can } from '@store/core/auth-permissions';
import { z } from 'zod';

import { requestOriginOk } from '@/lib/admin/bound-action';
import { commitImport, previewImport } from '@/lib/admin/csv-import';
import { currentSession } from '@/lib/admin/session';
import { createInFlight } from '@/lib/in-flight';
import { createRateLimiter } from '@/lib/rate-limit';
import { readCapped } from '@/lib/read-capped';
import { checkRequestLimit } from '@/lib/request-limits';

/**
 * CSV import: `POST /admin/upload/products-csv?mode=preview|commit` with the raw CSV as the body.
 *
 * Its own route, not a server action, for the reason the photo upload is one: `proxy.ts` buffers the
 * body of every request it handles (`proxyClientMaxBodySize` is 64 KB, about 25 rows with full
 * descriptions) and the proxy's matcher skips `admin/upload/`, so everything the proxy would have
 * done is done here, in this order:
 *   1. a cheap per-client limit BEFORE any database work;
 *   2. the content type (`text/csv` or `text/plain`), Origin (CSRF), a FULL admin session read from the
 *      database, the `catalog.import` permission, a per-user limit: all before a byte of the body is read;
 *   3. an IN-FLIGHT SLOT (one import at a time over everybody, one per user), held to the end: a
 *      commit is a long transaction and the parsed file is held in memory;
 *   4. the SIZE CAP ENFORCED WHILE THE BODY STREAMS (`CSV_LIMITS.maxBytes`, 2 MB) and a READ DEADLINE
 *      (no data for 15 s, or the whole body not in 60 s: 408);
 *   5. strict UTF-8 (a replacement character is refused, never stored);
 *   6. the same `adminAction` the server action used: Origin, session, permission, limit, zod, audit
 *      again, in one transaction. Formula cells are neutralised on EXPORT (`writeCsv`) and read back
 *      by `unsafeCell`; nothing here is ever evaluated, and the preview shows values as text.
 * Every response is `private, no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const preAuthLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
const clientLimiter = createRateLimiter({ limit: 60, windowMs: 10 * 60_000 });
const userLimiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });
const inFlight = createInFlight({ global: 1, perKey: 1 });

const querySchema = z.object({ mode: z.enum(['preview', 'commit']) });
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };

function reply(status: number, code: string, request?: Request): Response {
  void request?.body?.cancel().catch(() => undefined);
  return Response.json(
    { ok: false, code },
    { status, headers: request === undefined ? HEADERS : { ...HEADERS, Connection: 'close' } },
  );
}

/** The status of a refusal that `adminAction` or the parser reports by code. */
function statusOf(code: string): number {
  if (code === 'UNAUTHENTICATED') return 401;
  if (code === 'FORBIDDEN' || code === 'BAD_ORIGIN') return 403;
  if (code === 'RATE_LIMITED') return 429;
  if (code.startsWith('CSV_')) return 422;
  return 400;
}

export async function POST(request: Request): Promise<Response> {
  if (!(await checkRequestLimit(preAuthLimiter, request)).allowed)
    return reply(429, 'RATE_LIMITED', request);
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'text/csv' && type !== 'text/plain') return reply(415, 'UNSUPPORTED_TYPE', request);
  if (!(await requestOriginOk())) return reply(403, 'BAD_ORIGIN', request);
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return reply(401, 'UNAUTHENTICATED', request);
  if (!can(resolved.session.role, 'catalog.import')) return reply(403, 'FORBIDDEN', request);
  if (
    !(await checkRequestLimit(clientLimiter, request)).allowed ||
    !userLimiter.check(resolved.session.userId).allowed
  ) {
    return reply(429, 'RATE_LIMITED', request);
  }
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return reply(400, 'INVALID_INPUT', request);

  const release = inFlight.acquire(resolved.session.userId);
  if (release === null) return reply(429, 'BUSY', request);
  try {
    const read = await readCapped(request, {
      limit: CSV_LIMITS.maxBytes,
      idleMs: 15_000,
      totalMs: 60_000,
    });
    if (!read.ok)
      return reply(
        read.reason === 'timeout' ? 408 : 413,
        read.reason === 'timeout' ? 'TIMEOUT' : 'CSV_TOO_LARGE',
      );
    let csv: string;
    try {
      csv = new TextDecoder('utf-8', { fatal: true }).decode(read.body);
    } catch {
      return reply(422, 'CSV_INVALID_CHARACTERS');
    }
    if (csv.trim() === '') return reply(422, 'CSV_EMPTY');
    const result =
      query.data.mode === 'preview' ? await previewImport(csv) : await commitImport(csv);
    if (!result.ok) return reply(statusOf(result.code), result.code);
    return Response.json({ ok: true, data: result.data }, { headers: HEADERS });
  } finally {
    release();
  }
}
