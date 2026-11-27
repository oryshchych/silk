import { randomUUID } from 'node:crypto';

import {
  bannerExists,
  bannerImageKey,
  bannerImageQuerySchema,
  setBannerImage,
} from '@store/core/banners';
import { can } from '@store/core/auth-permissions';
import { ImageRejectedError, LIMITS, processImage } from '@store/media/process';
import { BANNERS_TAG } from '@store/shared/cache-tags';

import { adminAction, requestOriginOk } from '@/lib/admin/bound-action';
import { invalidateTags } from '@/lib/admin/invalidate';
import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { createInFlight } from '@/lib/in-flight';
import { mediaConfig } from '@/lib/media';
import { createRateLimiter } from '@/lib/rate-limit';
import { declaredTooLarge, readCapped } from '@/lib/read-capped';
import { checkRequestLimit } from '@/lib/request-limits';

/**
 * Banner picture upload: `POST /admin/upload/banner-image?bannerId=<uuid>&slot=desktop|mobile` with the raw image
 * as the body. Same hardening as the product photo route (its own route because the proxy buffers bodies, and the
 * proxy matcher skips `admin/upload/`): a per-client limit before any database work; Origin, a FULL admin session
 * and `banners.edit` before a byte of the body is read; an in-flight slot (at most 2 at once, 1 per user) that
 * bounds memory; the size cap enforced while streaming with a read deadline; the banner looked up BEFORE the
 * conversion; the type from the bytes, pixel cap, orientation and metadata stripping (`@store/media`); keys built
 * from ids only; files uploaded, then the row and the audit entry in one transaction; any failure removes the
 * files again; the files of the replaced picture are removed after the commit. Every response is `private, no-store`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const preAuthLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
const clientLimiter = createRateLimiter({ limit: 60, windowMs: 10 * 60_000 });
const userLimiter = createRateLimiter({ limit: 40, windowMs: 10 * 60_000 });
const inFlight = createInFlight({ global: 2, perKey: 1 });

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
function reply(status: number, code: string, request?: Request): Response {
  void request?.body?.cancel().catch(() => undefined);
  return Response.json(
    { ok: false, code },
    { status, headers: request === undefined ? HEADERS : { ...HEADERS, Connection: 'close' } },
  );
}
function warn(event: string, detail: Record<string, string | number>): void {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'media', event, ...detail })}\n`);
}

export async function POST(request: Request): Promise<Response> {
  if (!(await checkRequestLimit(preAuthLimiter, request)).allowed)
    return reply(429, 'RATE_LIMITED', request);
  if (!(await requestOriginOk())) return reply(403, 'BAD_ORIGIN', request);
  const resolved = await currentSession();
  if (resolved?.kind !== 'full') return reply(401, 'UNAUTHENTICATED', request);
  if (!can(resolved.session.role, 'banners.edit')) return reply(403, 'FORBIDDEN', request);
  if (
    !(await checkRequestLimit(clientLimiter, request)).allowed ||
    !userLimiter.check(resolved.session.userId).allowed
  ) {
    return reply(429, 'RATE_LIMITED', request);
  }
  const query = bannerImageQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) return reply(400, 'INVALID_INPUT', request);
  const media = await mediaConfig();
  if (media === null) return reply(503, 'MEDIA_NOT_CONFIGURED', request);
  if (declaredTooLarge(request, LIMITS.maxBytes)) return reply(413, 'TOO_LARGE', request);
  const release = inFlight.acquire(resolved.session.userId);
  if (release === null) return reply(429, 'BUSY', request);
  try {
    return await upload(request, query.data, media);
  } finally {
    release();
  }
}

type Media = NonNullable<Awaited<ReturnType<typeof mediaConfig>>>;

async function upload(
  request: Request,
  target: { bannerId: string; slot: 'desktop' | 'mobile' },
  media: Media,
): Promise<Response> {
  const read = await readCapped(request, {
    limit: LIMITS.maxBytes,
    idleMs: 15_000,
    totalMs: 60_000,
  });
  if (!read.ok) {
    return reply(
      read.reason === 'timeout' ? 408 : read.reason === 'aborted' ? 400 : 413,
      read.reason === 'timeout' ? 'TIMEOUT' : read.reason === 'aborted' ? 'ABORTED' : 'TOO_LARGE',
      request,
    );
  }
  if (read.body.length === 0) return reply(400, 'INVALID_INPUT');
  const db = await getDb();
  if (!(await bannerExists(db, target.bannerId))) return reply(404, 'BANNER_NOT_FOUND');

  let image;
  try {
    image = await processImage(read.body);
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
  const remove = async (keys: readonly string[], event: string): Promise<void> => {
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        await media.storage.remove(key);
      }),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected')
        warn(event, { key: keys[index] ?? '', status: 'cleanup failed' });
    });
  };
  const renditionUrls: Record<string, string> = {};
  try {
    for (const rendition of image.renditions) {
      const key = bannerImageKey(target.bannerId, imageId, rendition.size, rendition.format);
      await media.storage.put(key, rendition.body, `image/${rendition.format}`);
      uploaded.push(key);
      renditionUrls[`${rendition.size}.${rendition.format}`] = `${media.publicBase}/${key}`;
    }
  } catch {
    warn('storage put failed', { key: `banners/${target.bannerId}/${imageId}` });
    await remove(uploaded, 'orphan');
    return reply(502, 'STORAGE_FAILED');
  }
  const fullWebp = renditionUrls['full.webp'];
  if (fullWebp === undefined) {
    await remove(uploaded, 'orphan');
    return reply(500, 'GENERIC');
  }

  const replaced: { previousUrl: string | null } = { previousUrl: null };
  let result;
  try {
    result = await adminAction({
      permission: 'banners.edit',
      schema: bannerImageQuerySchema,
      input: target,
      run: async ({ tx, audit }) => {
        const done = await setBannerImage(tx, {
          bannerId: target.bannerId,
          slot: target.slot,
          url: fullWebp,
          width: image.width,
          height: image.height,
        });
        replaced.previousUrl = done.previousUrl;
        await audit({
          action: 'banner.image_set',
          entity: 'banner',
          entityId: target.bannerId,
          diff: { slot: target.slot, width: image.width, height: image.height },
        });
        return { imageId };
      },
    });
  } catch {
    warn('database write failed', { key: `banners/${target.bannerId}/${imageId}` });
    await remove(uploaded, 'orphan');
    return reply(500, 'GENERIC');
  }
  if (!result.ok) {
    await remove(uploaded, 'orphan');
    return reply(
      result.code === 'FORBIDDEN' ? 403 : result.code === 'RATE_LIMITED' ? 429 : 409,
      result.code,
    );
  }
  invalidateTags([BANNERS_TAG]);
  // The replaced picture's files: keys are rebuilt from the ids in its URL, never taken from it as a path.
  if (replaced.previousUrl !== null) {
    const match = /\/banners\/[0-9a-f-]{36}\/([0-9a-f-]{36})\/full\.webp$/.exec(
      replaced.previousUrl,
    );
    const oldId = match?.[1];
    if (oldId !== undefined && oldId !== imageId) {
      await remove(
        (['thumb', 'card', 'full'] as const).flatMap((size) =>
          (['webp', 'avif'] as const).map((format) =>
            bannerImageKey(target.bannerId, oldId, size, format),
          ),
        ),
        'orphan',
      );
    }
  }
  return Response.json({ ok: true, imageId }, { status: 201, headers: HEADERS });
}
