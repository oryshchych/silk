'use server';

import {
  bannerCreateSchema,
  bannerIdSchema,
  bannerUpdateSchema,
  createBanner,
  deleteBanner,
  updateBanner,
} from '@store/core/banners';
import { BANNERS_TAG } from '@store/shared/cache-tags';

import { adminAction } from '@/lib/admin/bound-action';
import { invalidateTags } from '@/lib/admin/invalidate';

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
  if (result.ok) invalidateTags([BANNERS_TAG]);
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
  if (result.ok && result.data.changed) invalidateTags([BANNERS_TAG]);
  return result;
}

export async function deleteBannerAction(input: unknown) {
  const result = await adminAction({
    permission: 'banners.edit',
    schema: bannerIdSchema,
    input,
    run: async ({ tx, input: parsed, audit }) => {
      await deleteBanner(tx, parsed.id);
      await audit({ action: 'banner.deleted', entity: 'banner', entityId: parsed.id });
      return { id: parsed.id };
    },
  });
  if (result.ok) invalidateTags([BANNERS_TAG]);
  return result;
}
