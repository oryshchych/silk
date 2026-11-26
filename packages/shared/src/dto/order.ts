/**
 * Замовлення очима ПОКУПЦЯ. Найризиковіше місце для витоку (AGENTS.md
 * §4b.3): у позиціях лежить `unit_cost_snapshot`, на замовленні —
 * `admin_note`, `ip`. Схема перелічує лише те, що бачить покупець; ролі
 * manager / finance отримають свої схеми у фазі 4.
 */
import { z } from 'zod';

import { moneyDto } from './money';

export const orderStatusValues = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;

export const paymentStatusValues = [
  'pending',
  'authorized',
  'paid',
  'failed',
  'expired',
  'refunded',
  'partially_refunded',
] as const;

export const customerOrderItemDto = z.object({
  name: z.string(),
  /** The product (null once it was deleted): the id analytics events carry, as in the feed's `item_group_id`. */
  productId: z.uuid().nullable(),
  sku: z.string(),
  sizeLabel: z.string(),
  colorName: z.string(),
  unitPrice: moneyDto,
  quantity: z.number().int().positive(),
  lineDiscount: moneyDto,
  lineTotal: moneyDto,
});

export const customerOrderDto = z.object({
  orderNumber: z.string(),
  paymentProvider: z.string().nullable(),
  deliveryMethod: z.string(),
  /** Nova Poshta city, branch name and street address as the buyer chose them. */
  deliveryCity: z.string().nullable(),
  deliveryPoint: z.string().nullable(),
  deliveryAddress: z.string().nullable(),
  status: z.enum(orderStatusValues),
  paymentStatus: z.enum(paymentStatusValues),
  createdAt: z.iso.datetime({ offset: true }),
  subtotal: moneyDto,
  discountTotal: moneyDto,
  shippingTotal: moneyDto,
  total: moneyDto,
  ttn: z.string().nullable(),
  items: z.array(customerOrderItemDto),
});

/**
 * The order as served for "order number plus phone". The number is sequential and phones are
 * often known, so this view carries no street address and no waybill; the full DTO is only for
 * the holder of the order's access token.
 */
export const trackedOrderDto = customerOrderDto.omit({ deliveryAddress: true, ttn: true });

export type CustomerOrderDto = z.output<typeof customerOrderDto>;
export type TrackedOrderDto = z.output<typeof trackedOrderDto>;
