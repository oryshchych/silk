'use server';

import {
  bulkUpdatePromos,
  createPromo,
  promoBulkSchema,
  promoCreateSchema,
  promoUpdateSchema,
  updatePromo,
} from '@store/core/promo-admin';

import { adminAction } from '@/lib/admin/bound-action';

/**
 * Promo codes (docs/PROMO_CODES.md section 7). Every action names `promo.manage`, which
 * `adminAction` checks BEFORE the input is parsed; the audit row is written in the same transaction.
 * The audit diff holds the fields that changed (never the free-text description), and uses the key
 * `name` for the code (the audit writer redacts any key called `code`). Promo codes are read at
 * checkout from the database on every quote, so there is no cache to invalidate.
 */
export async function createPromoCodeAction(input: unknown) {
  return await adminAction({
    permission: 'promo.manage',
    schema: promoCreateSchema,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      const created = await createPromo(tx, session.userId, parsed);
      await audit({
        action: 'promo.created',
        entity: 'promo_code',
        entityId: created.id,
        diff: {
          name: created.code,
          type: parsed.type,
          value: parsed.value,
          scope: parsed.scope,
          maxUses: parsed.maxUses,
        },
      });
      return created;
    },
  });
}

export async function updatePromoCodeAction(input: unknown) {
  return await adminAction({
    permission: 'promo.manage',
    schema: promoUpdateSchema,
    input,
    run: async ({ tx, input: parsed, audit, skipAudit }) => {
      const done = await updatePromo(tx, parsed);
      if (!done.changed) {
        skipAudit();
        return { id: parsed.id, changed: false };
      }
      const { description: _description, ...fields } = done.diff;
      await audit({
        action: 'promo.updated',
        entity: 'promo_code',
        entityId: parsed.id,
        diff: { ...fields, ...(_description === undefined ? {} : { description: 'changed' }) },
      });
      return { id: parsed.id, changed: true };
    },
  });
}

export async function bulkPromoCodesAction(input: unknown) {
  return await adminAction({
    permission: 'promo.manage',
    schema: promoBulkSchema,
    input,
    run: async ({ tx, input: parsed, audit, skipAudit }) => {
      const done = await bulkUpdatePromos(tx, parsed);
      if (done.changed.length === 0) {
        skipAudit();
        return { changed: 0 };
      }
      for (const row of done.changed) {
        await audit({
          action: parsed.op === 'deactivate' ? 'promo.deactivated' : 'promo.extended',
          entity: 'promo_code',
          entityId: row.id,
          diff: parsed.op === 'extend' ? { endsAt: parsed.endsAt } : { isActive: [true, false] },
        });
      }
      return { changed: done.changed.length };
    },
  });
}
