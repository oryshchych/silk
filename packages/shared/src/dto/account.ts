/**
 * What the signed-in CUSTOMER receives about their own account. Explicit field lists (zod drops
 * unknown keys): no cost, no admin note, no tags, no other customer's data, no internal ids beyond
 * the ones the customer needs to name their own record in the next request.
 */
import { z } from 'zod';

import { customerOrderDto, orderStatusValues } from './order';
import { moneyDto } from './money';

export const accountOrderRowDto = z.object({
  orderNumber: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  status: z.enum(orderStatusValues),
  total: moneyDto,
  itemCount: z.number().int().nonnegative(),
});

export const accountOrderDto = customerOrderDto;

export const addressDto = z.object({
  id: z.uuid(),
  recipientName: z.string(),
  phone: z.string(),
  deliveryMethod: z.enum(['np_warehouse', 'np_courier', 'ukrposhta']),
  settlementRef: z.string().nullable(),
  settlementName: z.string().nullable(),
  warehouseRef: z.string().nullable(),
  warehouseName: z.string().nullable(),
  street: z.string().nullable(),
  house: z.string().nullable(),
  apartment: z.string().nullable(),
  postcode: z.string().nullable(),
  isDefault: z.boolean(),
});

export const profileDto = z.object({
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  locale: z.enum(['uk', 'en']),
  acceptsMarketing: z.boolean(),
  braSizeId: z.uuid().nullable(),
  apparelSizeId: z.uuid().nullable(),
});

export type AccountOrderRowDto = z.output<typeof accountOrderRowDto>;
export type AddressDto = z.output<typeof addressDto>;
export type ProfileDto = z.output<typeof profileDto>;
