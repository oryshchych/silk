import { randomUUID } from 'node:crypto';

import { addProductImage, assertRoomForImage, imageKey } from '@store/core/admin-images';
import { can } from '@store/core/auth-permissions';
import { LIMITS, processImage, ImageRejectedError } from '@store/media/process';
import { z } from 'zod';

import { adminAction } from '@/lib/admin/bound-action';
import { requestOriginOk } from '@/lib/admin/bound-action';
import { invalidateTags } from '@/lib/admin/invalidate';
import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { mediaConfig } from '@/lib/media';
import { readCapped } from '@/lib/read-capped';
import { createRateLimiter } from '@/lib/rate-limit';
import { checkRequestLimit } from '@/lib/request-limits';
import { createSemaphore } from '@/lib/semaphore';

/**
 * Photo upload: `POST /admin/upload/product-image?productId=<uuid>` with the raw image as the body.
 *
 * Its own route, not a server action: `proxy.ts` buffers the body of every request it handles
 * (`proxyClientMaxBodySize` is 64 KB) and a photo is megabytes, so the proxy's matcher skips this
 * path and everything the proxy would have done is done here, in this order:
 *   1. Origin (CSRF), a FULL admin session read from the database, the `media.upload` permission,
 *      a per-client and a per-user limit: all before a single byte of the body is read;
 *   2. the declared length, then the SIZE CAP ENFORCED WHILE THE BODY STREAMS (a client that lies
 *      about or omits the length is cut off at the cap, never buffered past it);
 *   3. the type from the bytes, the pixel cap, orientation, metadata stripping (`@store/media`);
 *   4. at most 2 conversions at once (CPU and memory are bounded), more are refused at once;
 *   5. keys built from ids only; files uploaded, then the row and the audit entry in one
 *      transaction; on any failure after the upload the files are removed again.
 * Every response is `private, no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const clientLimiter = createRateLimiter({ limit: 60, windowMs: 10 * 60_000 });
const userLimiter = createRateLimiter({ limit: 40, windowMs: 10 * 60_000 });
const conversions = createSemaphore(2, 2);

const querySchema = z.object({ productId: z.uuid() });

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const reply = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  Response.json({ ok: false, code, ...extra }, { status, headers: HEADERS });

export async function POST(request: Request): Promise<Response> {
  if (!(await requestOriginOk())) return reply(403, 'BAD_ORIGIN');
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return reply(401, 'UNAUTHENTICATED');
  if (!can(resolved.session.role, 'media.upload')) return reply(403, 'FORBIDDEN');
  if (
    !(await checkRequestLimit(clientLimiter, request)).allowed ||
    !userLimiter.check(resolved.session.userId).allowed
  ) {
    return reply(429, 'RATE_LIMITED');
  }
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return reply(400, 'INVALID_INPUT');
  const media = await mediaConfig();
  if (media === null) return reply(503, 'MEDIA_NOT_CONFIGURED');

  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > LIMITS.maxBytes) return reply(413, 'TOO_LARGE');
  const body = await readCapped(request, LIMITS.maxBytes);
  if (body === null) return reply(413, 'TOO_LARGE');
  if (body.length === 0) return reply(400, 'INVALID_INPUT');

  const { productId } = query.data;
  const db = await getDb();
  try {
    await assertRoomForImage(db, productId);
  } catch {
    return reply(409, 'ADMIN_TOO_MANY_IMAGES');
  }

  const converted = await conversions.run(async () => {
    try {
      return { ok: true as const, image: await processImage(body) };
    } catch (error) {
      if (error instanceof ImageRejectedError) return { ok: false as const, reason: error.reason };
      throw error;
    }
  });
  if (!converted.ran) return reply(429, 'RATE_LIMITED');
  if (!converted.value.ok) {
    const reason = converted.value.reason;
    return reply(
      reason === 'unsupported_type' ? 415 : reason === 'too_large' ? 413 : 422,
      `IMAGE_${reason.toUpperCase()}`,
    );
  }

  const { image } = converted.value;
  const imageId = randomUUID();
  const uploaded: string[] = [];
  const cleanup = async (): Promise<void> => {
    await Promise.allSettled(
      uploaded.map(async (key) => {
        await media.storage.remove(key);
      }),
    );
  };
  const variants: Record<string, string> = {};
  try {
    for (const rendition of image.renditions) {
      const key = imageKey(productId, imageId, rendition.size, rendition.format);
      await media.storage.put(key, rendition.body, `image/${rendition.format}`);
      uploaded.push(key);
      variants[`${rendition.size}.${rendition.format}`] = `${media.publicBase}/${key}`;
    }
  } catch {
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
