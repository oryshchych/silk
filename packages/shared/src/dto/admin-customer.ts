/**
 * Admin customer DTOs. A customer is a buyer identified by their email (checkout is guest-only
 * until accounts exist, phase 7): everything here is derived from orders, plus the tags and the
 * note a person added. The URL key is a hash of the email, never the email itself. No cost, no
 * address, no payment data: a customer screen is read for who buys what, not for money handling.
 */
import { z } from 'zod';

import { moneyDto } from './money';
import { orderStatusValues } from './order';

export const customerSegmentValues = ['new', 'repeat', 'vip', 'lapsed'] as const;

export const adminCustomerRowDto = z.object({
  key: z.string().regex(/^[0-9a-f]{32}$/),
  email: z.string(),
  name: z.string(),
  phone: z.string(),
  ordersCount: z.number().int(),
  ltv: moneyDto,
  lastOrderAt: z.iso.datetime({ offset: true }),
  segment: z.enum(customerSegmentValues),
  tags: z.array(z.string()),
});
export type AdminCustomerRowDto = z.output<typeof adminCustomerRowDto>;

export const adminCustomerDto = adminCustomerRowDto.extend({
  firstOrderAt: z.iso.datetime({ offset: true }),
  averageOrder: moneyDto,
  note: z.string().nullable(),
  /** Units bought per size, by size system: what the buyer's purchases say they wear. */
  sizes: z.array(
    z.object({ system: z.string(), label: z.string(), units: z.number().int().positive() }),
  ),
  /** The most bought size of each system (ties go to the earlier label). */
  favouriteSizes: z.array(z.object({ system: z.string(), label: z.string() })),
  orders: z.array(
    z.object({
      id: z.uuid(),
      orderNumber: z.string(),
      createdAt: z.iso.datetime({ offset: true }),
      status: z.enum(orderStatusValues),
      total: moneyDto,
    }),
  ),
});
export type AdminCustomerDto = z.output<typeof adminCustomerDto>;
