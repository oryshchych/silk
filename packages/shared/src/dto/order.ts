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

export type CustomerOrderDto = z.output<typeof customerOrderDto>;
