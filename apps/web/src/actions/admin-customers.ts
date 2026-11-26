'use server';

import { updateCustomer, updateCustomerSchema } from '@store/core/customers-admin-update';

import { adminAction } from '@/lib/admin/bound-action';

/**
 * Tags and the internal note of a customer: `customers.manage`, checked by `adminAction` before the
 * input is parsed. One audit row with the author and address; the note text is not copied into it
 * (it lives on the customer), only that it changed. A repeat that changes nothing writes no row.
 */
export async function updateCustomerAction(input: unknown) {
  return await adminAction({
    permission: 'customers.manage',
    schema: updateCustomerSchema,
    input,
    run: async ({ tx, input: parsed, audit, skipAudit }) => {
      const done = await updateCustomer(tx, parsed);
      if (!done.changed) {
        skipAudit();
        return { changed: false };
      }
      await audit({
        action: 'update',
        entity: 'customer',
        entityId: parsed.key,
        diff: {
          tags: { from: done.tagsFrom, to: done.tagsTo },
          note: done.noteChanged ? 'changed' : 'same',
        },
      });
      return { changed: true };
    },
  });
}
