'use server';

import {
  createLegalDraft,
  deleteLegalDraft,
  legalCreateSchema,
  legalIdSchema,
  legalUpdateSchema,
  publishLegalDocument,
  setLegalFile,
  updateLegalDraft,
} from '@store/core/legal';
import { LEGAL_NAV_TAG, legalTag } from '@store/shared/cache-tags';

import { adminAction } from '@/lib/admin/bound-action';
import { invalidateTags } from '@/lib/admin/invalidate';
import { mediaConfig } from '@/lib/media';

/**
 * Legal documents. Writing a draft needs `legal.edit`, publishing and deleting a draft need
 * `legal.publish`: each is checked by `adminAction` before the input is parsed. The audit rows name the
 * kind, locale and version, never the text. A draft is never public, so only a PUBLISH drops cached pages
 * (after the commit); a version with a future start drops them too (harmless) and the pages pick it up by
 * the database clock when the time comes.
 */
export async function createLegalDraftAction(input: unknown) {
  return await adminAction({
    permission: 'legal.edit',
    schema: legalCreateSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      const created = await createLegalDraft(tx, session.userId, parsed);
      await audit({
        action: 'legal.created',
        entity: 'legal_document',
        entityId: created.id,
        diff: { kind: parsed.kind, locale: parsed.locale, version: created.version },
      });
      return created;
    },
  });
}

export async function updateLegalDraftAction(input: unknown) {
  return await adminAction({
    permission: 'legal.edit',
    schema: legalUpdateSchema,
    input,
    run: async ({ tx, input: parsed, audit }) => {
      const done = await updateLegalDraft(tx, parsed);
      await audit({
        action: 'legal.updated',
        entity: 'legal_document',
        entityId: parsed.id,
        diff: { kind: done.kind, locale: done.locale },
      });
      return { id: parsed.id };
    },
  });
}

export async function publishLegalAction(input: unknown) {
  const result = await adminAction({
    permission: 'legal.publish',
    schema: legalIdSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      const done = await publishLegalDocument(tx, session.userId, parsed.id);
      await audit({
        action: 'legal.published',
        entity: 'legal_document',
        entityId: parsed.id,
        diff: {
          kind: done.kind,
          locale: done.locale,
          version: done.version,
          effectiveFrom: done.effectiveFrom,
        },
      });
      return done;
    },
  });
  if (result.ok) invalidateTags([legalTag(result.data.kind), LEGAL_NAV_TAG]);
  return result;
}

export async function deleteLegalDraftAction(input: unknown) {
  const result = await adminAction({
    permission: 'legal.publish',
    schema: legalIdSchema,
    input,
    run: async ({ tx, input: parsed, audit }) => {
      const done = await deleteLegalDraft(tx, parsed.id);
      await audit({
        action: 'legal.draft_deleted',
        entity: 'legal_document',
        entityId: parsed.id,
        diff: { kind: done.kind, locale: done.locale },
      });
      return { id: parsed.id, fileKey: done.fileKey };
    },
  });
  // The draft's PDF sits on the public media host: it goes with the draft (after the commit, best effort).
  if (result.ok && result.data.fileKey !== null) {
    const media = await mediaConfig();
    await media?.storage.remove(result.data.fileKey).catch(() => undefined);
  }
  return result.ok ? { ok: true as const, data: { id: result.data.id } } : result;
}

/** Removes the PDF of a draft (the stored object is deleted after the commit, best effort). */
export async function removeLegalFileAction(input: unknown) {
  const result = await adminAction({
    permission: 'legal.edit',
    schema: legalIdSchema,
    input,
    run: async ({ tx, input: parsed, audit }) => {
      const { previousKey } = await setLegalFile(tx, parsed.id, null);
      await audit({
        action: 'legal.file_removed',
        entity: 'legal_document',
        entityId: parsed.id,
        diff: { hadFile: previousKey !== null },
      });
      return { previousKey };
    },
  });
  if (result.ok && result.data.previousKey !== null) {
    const media = await mediaConfig();
    await media?.storage.remove(result.data.previousKey).catch(() => undefined);
  }
  // The object key stays on the server.
  return result.ok ? { ok: true as const, data: { removed: true } } : result;
}
