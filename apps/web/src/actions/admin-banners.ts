'use server';

import {
  bannerCreateSchema,
  bannerKeysOfUrl,
  bannerIdSchema,
  bannerUpdateSchema,
  createBanner,
  deleteBanner,
  updateBanner,
} from '@store/core/banners';
import { BANNERS_TAG } from '@store/shared/cache-tags';

import { adminAction } from '@/lib/admin/bound-action';
import { updateTags } from '@/lib/admin/invalidate';
import { mediaConfig } from '@/lib/media';

/**
 * Home-page banners. Every action names `banners.edit`, checked by `adminAction` BEFORE the input is parsed; the
 * audit row is written in the same transaction (field names and values of what changed, never the pictures'
 * bytes). The cached home banners are dropped only AFTER the commit, and only when something changed.
 */
export async function createBannerAction(input: unknown) {
  const result = await adminAction({
    permission: 'banners.edit',
    schema: bannerCreateSchema,
    input,
    run: async ({ tx, input: parsed, audit }) => {
      const created = await createBanner(tx, parsed);
      await audit({
        action: 'banner.created',
        entity: 'banner',
        entityId: created.id,
        diff: { href: parsed.href, startsAt: parsed.startsAt, endsAt: parsed.endsAt },
      });
      return created;
    },
  });
  if (result.ok) updateTags([BANNERS_TAG]);
  return result;
}

export async function updateBannerAction(input: unknown) {
  const result = await adminAction({
    permission: 'banners.edit',
    schema: bannerUpdateSchema,
    input,
    run: async ({ tx, input: parsed, audit, skipAudit }) => {
      const done = await updateBanner(tx, parsed);
      if (!done.changed) {
        skipAudit();
        return { id: parsed.id, changed: false };
      }
      await audit({
        action: 'banner.updated',
        entity: 'banner',
        entityId: parsed.id,
        diff: done.diff,
      });
      return { id: parsed.id, changed: true };
    },
  });
  if (result.ok && result.data.changed) updateTags([BANNERS_TAG]);
  return result;
}

export async function deleteBannerAction(input: unknown) {
  const result = await adminAction({
    permission: 'banners.edit',
    schema: bannerIdSchema,
    input,
    run: async ({ tx, input: parsed, audit }) => {
      const gone = await deleteBanner(tx, parsed.id);
      await audit({ action: 'banner.deleted', entity: 'banner', entityId: parsed.id });
      return { id: parsed.id, urls: gone.urls };
    },
  });
  if (!result.ok) return result;
  updateTags([BANNERS_TAG]);
  // After the commit: the picture files go too (best effort, keys rebuilt from the ids in the stored URLs).
  const media = await mediaConfig();
  if (media !== null) {
    const keys = result.data.urls.flatMap((url) => bannerKeysOfUrl(url));
    const outcome = await Promise.allSettled(
      keys.map(async (key) => {
        await media.storage.remove(key);
      }),
    );
    outcome.forEach((entry, index) => {
      if (entry.status === 'rejected') {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', scope: 'media', event: 'orphan', key: keys[index] ?? '' })}\n`,
        );
      }
    });
  }
  return { ok: true as const, data: { id: result.data.id } };
}
