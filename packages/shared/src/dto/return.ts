/**
 * Return requests as served. The CUSTOMER view lists what the customer needs (their own request, its
 * lines and status) and nothing internal: no admin note, no refund operation, no other customer's data.
 * The ADMIN view adds the moderator's fields and the refund state.
 */
import { z } from 'zod';

import { moneyDto } from './money';

export const returnReasonValues = [
  'defect',
  'wrong_item',
  'not_as_described',
  'changed_mind',
  'wrong_size',
  'other',
] as const;
export const returnStatusValues = [
  'requested',
  'approved',
  'rejected',
  'in_transit',
  'received',
  'refunded',
  'closed',
] as const;

export const customerReturnDto = z.object({
  requestNumber: z.string(),
  orderNumber: z.string(),
  status: z.enum(returnStatusValues),
  reason: z.enum(returnReasonValues),
  createdAt: z.iso.datetime({ offset: true }),
  items: z.array(
    z.object({
      name: z.string(),
      sizeLabel: z.string(),
      quantity: z.number().int().positive(),
      receivedQuantity: z.number().int().nonnegative(),
    }),
  ),
});

export const eligibleOrderDto = z.object({
  orderNumber: z.string(),
  deliveredAt: z.iso.datetime({ offset: true }),
  /** The last day a request is accepted (database time of the window). */
  deadline: z.iso.datetime({ offset: true }),
  items: z.array(
    z.object({
      orderItemId: z.uuid(),
      name: z.string(),
      sizeLabel: z.string(),
      /** How many units can still be returned. */
      remaining: z.number().int().positive(),
    }),
  ),
});

export const adminReturnDto = z.object({
  id: z.uuid(),
  requestNumber: z.string(),
  orderId: z.uuid(),
  orderNumber: z.string(),
  customerEmail: z.string().nullable(),
  status: z.enum(returnStatusValues),
  reason: z.enum(returnReasonValues),
  customerComment: z.string().nullable(),
  adminNote: z.string().nullable(),
  policyVersion: z.string(),
  refundAmount: moneyDto.nullable(),
  suggestedRefund: moneyDto,
  restock: z.boolean(),
  refundState: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  items: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      sizeLabel: z.string(),
      quantity: z.number().int().positive(),
      receivedQuantity: z.number().int().nonnegative(),
      restockedQuantity: z.number().int().nonnegative(),
    }),
  ),
});

export type CustomerReturnDto = z.output<typeof customerReturnDto>;
export type EligibleOrderDto = z.output<typeof eligibleOrderDto>;
export type AdminReturnDto = z.output<typeof adminReturnDto>;
