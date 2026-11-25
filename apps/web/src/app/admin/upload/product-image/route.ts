import { randomUUID } from 'node:crypto';

import {
  addProductImage,
  assertRoomForImage,
  imageKey,
  productExists,
} from '@store/core/admin-images';
import { can } from '@store/core/auth-permissions';
import { ImageRejectedError, LIMITS, processImage } from '@store/media/process';
import { z } from 'zod';

import { adminAction, requestOriginOk } from '@/lib/admin/bound-action';
import { invalidateTags } from '@/lib/admin/invalidate';
import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { createInFlight } from '@/lib/in-flight';
import { mediaConfig } from '@/lib/media';
import { createRateLimiter } from '@/lib/rate-limit';
import { readCapped } from '@/lib/read-capped';
import { checkRequestLimit } from '@/lib/request-limits';

/**
 * Photo upload: `POST /admin/upload/product-image?productId=<uuid>` with the raw image as the body.
 *
 * Its own route, not a server action: `proxy.ts` buffers the body of every request it handles
 * (`proxyClientMaxBodySize` is 64 KB) and a photo is megabytes, so the proxy's matcher skips this
 * path and everything the proxy would have done is done here, in this order:
 *   1. a cheap per-client limit BEFORE any database work (a flood of stale cookies costs no lookup);
 *   2. Origin (CSRF), a FULL admin session read from the database, the `media.upload` permission,
 *      a per-user limit: all before a single byte of the body is read;
 *   3. an IN-FLIGHT SLOT, taken before the body is read and held to the end of the request: at
 *      most 2 uploads at once over everybody and 1 per user, the rest refused at once (429). This
 *      is what bounds MEMORY: each admitted upload holds at most one 12 MB body, one decoded
 *      image (at most 40 MP) and the renditions, so the process holds a known multiple of that
 *      and never a pile of bodies waiting for their turn;
 *   4. the SIZE CAP ENFORCED WHILE THE BODY STREAMS into ONE buffer allocated from the declared
 *      length (no list of chunks, no second copy), and a READ DEADLINE (no data for 15 s, or the
 *      whole body not in 60 s: 408, the slot is released): a client that sends headers and then
 *      nothing cannot hold a slot;
 *   5. the product is looked up and the photo count checked BEFORE the conversion;
 *   6. the type from the bytes, the pixel cap, orientation, metadata stripping (`@store/media`);
 *   7. keys built from ids only; files uploaded, then the row and the audit entry in one
 *      transaction; on any failure after the upload the files are removed again (a removal that
 *      itself fails leaves orphan files and is logged: see docs/SECURITY.md "Uploads").
 * Every response is `private, no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Before the session lookup: 120 POSTs a minute per client address, valid cookie or not. */
const preAuthLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
const clientLimiter = createRateLimiter({ limit: 60, windowMs: 10 * 60_000 });
const userLimiter = createRateLimiter({ limit: 40, windowMs: 10 * 60_000 });
/**
 * Two uploads at once over everybody and one per user. Measured against the production image at
 * 1 GiB: a worst-case upload (a 30 MP progressive JPEG or a 40 MP PNG) peaks near 400 MB with the
 * body, the decode and the encoders, so the number of slots times that peak, plus the rest of the
 * app, must stay under the container limit.
 */
const inFlight = createInFlight({ global: 2, perKey: 1 });

const querySchema = z.object({ productId: z.uuid().transform((value) => value.toLowerCase()) });

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
/** A refusal: the request body is never read, the unread stream is cancelled and the connection is closed. */
function reply(status: number, code: string, request?: Request): Response {
  void request?.body?.cancel().catch(() => undefined);
  return Response.json(
    { ok: false, code },
    { status, headers: request === undefined ? HEADERS : { ...HEADERS, Connection: 'close' } },
  );
}

/** Operational log line: an object key and a status, never a URL, a credential or a body. */
function warn(event: string, detail: Record<string, string | number>): void {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'media', event, ...detail })}\n`);
}

export async function POST(request: Request): Promise<Response> {
  if (!(await checkRequestLimit(preAuthLimiter, request)).allowed)
    return reply(429, 'RATE_LIMITED', request);
  if (!(await requestOriginOk())) return reply(403, 'BAD_ORIGIN', request);
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return reply(401, 'UNAUTHENTICATED', request);
  if (!can(resolved.session.role, 'media.upload')) return reply(403, 'FORBIDDEN', request);
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
    return await upload(request, query.data.productId, media);
  } finally {
    release();
  }
}

async function upload(
  request: Request,
  productId: string,
  media: NonNullable<Awaited<ReturnType<typeof mediaConfig>>>,
): Promise<Response> {
  const read = await readCapped(request, {
    limit: LIMITS.maxBytes,
    idleMs: 15_000,
    totalMs: 60_000,
  });
  if (!read.ok)
    return reply(
      read.reason === 'timeout' ? 408 : 413,
      read.reason === 'timeout' ? 'TIMEOUT' : 'TOO_LARGE',
    );
  const body = read.body;
  if (body.length === 0) return reply(400, 'INVALID_INPUT');

  const db = await getDb();
  // Before the conversion: a photo for a product that does not exist, or that is full, costs nothing.
  if (!(await productExists(db, productId))) return reply(404, 'ADMIN_NOT_FOUND');
  try {
    await assertRoomForImage(db, productId);
  } catch {
    return reply(409, 'ADMIN_TOO_MANY_IMAGES');
  }

  let image;
  try {
    image = await processImage(body);
  } catch (error) {
    if (!(error instanceof ImageRejectedError)) throw error;
    const reason = error.reason;
    return reply(
      reason === 'unsupported_type' ? 415 : reason === 'too_large' ? 413 : 422,
      `IMAGE_${reason.toUpperCase()}`,
    );
  }

  const imageId = randomUUID();
  const uploaded: string[] = [];
  const cleanup = async (): Promise<void> => {
    const results = await Promise.allSettled(
      uploaded.map(async (key) => {
        await media.storage.remove(key);
      }),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        // An orphan object: nothing references it and nothing will remove it (no reaper yet).
        warn('orphan', { key: uploaded[index] ?? '', status: 'cleanup failed' });
      }
    });
  };
  const variants: Record<string, string> = {};
  try {
    for (const rendition of image.renditions) {
      const key = imageKey(productId, imageId, rendition.size, rendition.format);
      await media.storage.put(key, rendition.body, `image/${rendition.format}`);
      uploaded.push(key);
      variants[`${rendition.size}.${rendition.format}`] = `${media.publicBase}/${key}`;
    }
  } catch (error) {
    warn('storage put failed', {
      key: imageKey(productId, imageId, 'full', 'webp').replace(/\/[^/]+$/, ''),
      status:
        error instanceof Error && 'status' in error && typeof error.status === 'number'
          ? error.status
          : 0,
    });
    await cleanup();
    return reply(502, 'STORAGE_FAILED');
  }

  const fullWebp = variants['full.webp'];
  if (fullWebp === undefined) {
    await cleanup();
    return reply(500, 'GENERIC');
  }
  let tags: string[] = [];
  let result;
  try {
    result = await adminAction({
      permission: 'media.upload',
      schema: querySchema,
      input: { productId },
      run: async ({ tx, audit }) => {
        const outcome = await addProductImage(tx, {
          productId,
          imageId,
          url: fullWebp,
          variants,
          width: image.width,
          height: image.height,
        });
        await audit(outcome.audit);
        tags = outcome.tags;
        return outcome.data;
      },
    });
  } catch {
    warn('database write failed', {
      key: imageKey(productId, imageId, 'full', 'webp').replace(/\/[^/]+$/, ''),
    });
    await cleanup();
    return reply(500, 'GENERIC');
  }
  if (!result.ok) {
    await cleanup();
    return reply(
      result.code === 'FORBIDDEN' ? 403 : result.code === 'RATE_LIMITED' ? 429 : 409,
      result.code,
    );
  }
  invalidateTags(tags);
  return Response.json({ ok: true, imageId }, { status: 201, headers: HEADERS });
}
