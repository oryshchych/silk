/**
 * Input schemas of the order admin: the allowlist of what an action may change. An order id is
 * always a uuid; free text is trimmed, bounded and free of NUL bytes (Postgres refuses them).
 */
import { z } from 'zod';

import { hryvnias } from '../catalog-admin/schemas.ts';

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !value.includes('\u0000'), 'no NUL byte');

export const orderIdSchema = z.object({ orderId: z.uuid() });

/** A cancellation always carries a reason: it is the first thing asked when a customer calls. */
export const cancelOrderSchema = z.object({ orderId: z.uuid(), reason: text(3, 500) });

export const orderNoteSchema = z.object({ orderId: z.uuid(), text: text(1, 1000) });

export const confirmTransferSchema = z.object({
  orderId: z.uuid(),
  bankReference: text(1, 128),
  amount: hryvnias,
});

/** Change quantities or take lines off a not-yet-shipped order; a reason is always recorded. */
export const editItemsSchema = z.object({
  orderId: z.uuid(),
  reason: text(3, 300),
  changes: z
    .array(z.object({ itemId: z.uuid(), quantity: z.number().int().min(0).max(1000) }))
    .min(1)
    .max(50),
});

/** Refund: the whole remaining amount, or a positive sum in hryvnias; a short reason (provider limit). */
export const refundSchema = z.object({
  orderId: z.uuid(),
  amount: hryvnias.refine((value) => value > 0, 'must be positive').optional(),
  attemptId: z.uuid().optional(),
  /** Made once per form mount; a repeat of the same request is the same refund. */
  requestId: z.uuid().optional(),
  reason: text(3, 200),
});

export const resolveWaybillSchema = z.object({
  orderId: z.uuid(),
  resolution: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('attach'),
      ttn: z
        .string()
        .trim()
        .regex(/^\d{14}$/),
    }),
    z.object({ kind: z.literal('none') }),
  ]),
});

/** Withdraw a refund that was never sent. */
export const refundOperationSchema = z.object({ operationId: z.uuid() });

/**
 * Close a refund whose answer is unknown with what the provider's portal says. The person confirms
 * the outcome; the note is the evidence (where it was checked), short and free of card data.
 */
export const resolveRefundSchema = z.object({
  operationId: z.uuid(),
  outcome: z.enum(['succeeded', 'failed']),
  note: text(3, 200),
});
