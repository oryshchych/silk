import { randomUUID } from 'node:crypto';

import { assertLegalDraft, legalPdfKey, setLegalFile } from '@store/core/legal';
import { can } from '@store/core/auth-permissions';
import { sniffPdf } from '@store/media/sniff';
import { z } from 'zod';

import { adminAction, requestOriginOk } from '@/lib/admin/bound-action';
import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { createInFlight } from '@/lib/in-flight';
import { mediaConfig } from '@/lib/media';
import { createRateLimiter } from '@/lib/rate-limit';
import { readCapped } from '@/lib/read-capped';
import { checkRequestLimit } from '@/lib/request-limits';

/**
 * PDF of a legal draft: `POST /admin/upload/legal-pdf?id=<uuid>` with the raw file as the body. Same shape
 * and order as the photo route (its own route because `proxy.ts` buffers bodies; every check is done here):
 * a cheap per-client limit, Origin, a FULL session, `legal.edit`, a per-user limit, an in-flight slot taken
 * BEFORE the body is read, the size cap and the read deadline enforced while the body streams, the type read
 * from the BYTES (`%PDF-`, never the extension or the declared type), the draft checked before the upload,
 * the object stored with `Content-Type: application/pdf` and `Content-Disposition: attachment` (it
 * downloads, it never renders inline), then the row and the audit entry in one transaction. On any failure
 * after the upload the object is removed again. Every response is `private, no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const preAuthLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const clientLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });
const userLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });
const inFlight = createInFlight({ global: 2, perKey: 1 });

const querySchema = z.object({ id: z.uuid().transform((value) => value.toLowerCase()) });

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
function reply(status: number, code: string, request?: Request): Response {
  void request?.body?.cancel().catch(() => undefined);
  return Response.json(
    { ok: false, code },
    { status, headers: request === undefined ? HEADERS : { ...HEADERS, Connection: 'close' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!(await checkRequestLimit(preAuthLimiter, request)).allowed)
    return reply(429, 'RATE_LIMITED', request);
  if (!(await requestOriginOk())) return reply(403, 'BAD_ORIGIN', request);
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return reply(401, 'UNAUTHENTICATED', request);
  if (!can(resolved.session.role, 'legal.edit')) return reply(403, 'FORBIDDEN', request);
  if (
    !(await checkRequestLimit(clientLimiter, request)).allowed ||
    !userLimiter.check(resolved.session.userId).allowed
  ) {
    return reply(429, 'RATE_LIMITED', request);
  }
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return reply(400, 'INVALID_INPUT', request);
  const media = await mediaConfig();
  if (media === null) return reply(503, 'MEDIA_NOT_CONFIGURED', request);

  const release = inFlight.acquire(resolved.session.userId);
  if (release === null) return reply(429, 'BUSY', request);
  try {
    return await upload(request, query.data.id, media);
  } finally {
    release();
  }
}

async function upload(
  request: Request,
  documentId: string,
  media: NonNullable<Awaited<ReturnType<typeof mediaConfig>>>,
): Promise<Response> {
  const read = await readCapped(request, { limit: MAX_PDF_BYTES, idleMs: 15_000, totalMs: 60_000 });
  if (!read.ok)
    return reply(
      read.reason === 'timeout' ? 408 : 413,
      read.reason === 'timeout' ? 'TIMEOUT' : 'TOO_LARGE',
    );
  const body = read.body;
  if (body.length === 0) return reply(400, 'INVALID_INPUT');
  if (!sniffPdf(body)) return reply(415, 'PDF_UNSUPPORTED_TYPE');

  const db = await getDb();
  try {
    await assertLegalDraft(db, documentId);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'GENERIC';
    return reply(code === 'LEGAL_NOT_FOUND' ? 404 : 409, code);
  }

  const key = legalPdfKey(documentId, randomUUID());
  try {
    await media.storage.put(key, body, 'application/pdf', {
      contentDisposition: 'attachment; filename="document.pdf"',
    });
  } catch {
    return reply(502, 'STORAGE_FAILED');
  }
  const remove = async (objectKey: string): Promise<void> => {
    await media.storage.remove(objectKey).catch(() => {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', scope: 'media', event: 'orphan', key: objectKey })}\n`,
      );
    });
  };

  let result;
  try {
    result = await adminAction({
      permission: 'legal.edit',
      schema: querySchema,
      input: { id: documentId },
      run: async ({ tx, audit }) => {
        const done = await setLegalFile(tx, documentId, {
          url: `${media.publicBase}/${key}`,
          key,
          size: body.length,
        });
        await audit({
          action: 'legal.file_set',
          entity: 'legal_document',
          entityId: documentId,
          diff: { size: body.length },
        });
        return done;
      },
    });
  } catch {
    await remove(key);
    return reply(500, 'GENERIC');
  }
  if (!result.ok) {
    await remove(key);
    return reply(
      result.code === 'FORBIDDEN' ? 403 : result.code === 'RATE_LIMITED' ? 429 : 409,
      result.code,
    );
  }
  if (result.data.previousKey !== null) await remove(result.data.previousKey);
  return Response.json({ ok: true }, { status: 201, headers: HEADERS });
}
