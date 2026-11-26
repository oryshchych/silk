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
