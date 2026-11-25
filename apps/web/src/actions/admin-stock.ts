'use server';

import { adjustStockSchema } from '@store/core/admin-schemas';
import { adjustVariantStock } from '@store/core/admin-stock';

import { catalogAction } from '@/lib/admin/catalog-action';

/**
 * Manual stock change: one atomic UPDATE plus a history row (`adjustStock`), the audit entry from
 * its result, the request id that makes a double submit harmless, the author from the verified
 * session (never from the input). A change that would leave less than is reserved is refused.
 */
export async function adjustStockAction(input: unknown) {
  return await catalogAction({
    permission: 'stock.adjust',
    schema: adjustStockSchema,
    input,
    op: async (tx, parsed, session) =>
      await adjustVariantStock(tx, {
        variantId: parsed.variantId,
        change:
          parsed.mode === 'delta'
            ? { kind: 'delta', delta: parsed.amount }
            : { kind: 'set', quantity: parsed.amount },
        reason: parsed.reason,
        note: parsed.note ?? null,
        userId: session.userId,
        requestId: parsed.requestId,
      }),
  });
}
