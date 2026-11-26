/**
 * Admin order DTOs: the explicit list of fields an admin screen may receive (AGENTS.md 4b.3).
 * What never leaves the server, whatever the role: the buyer's access token hash, the client IP and
 * user agent, the raw payment payloads and message keys. What leaves only for a role that holds
 * `catalog.cost.view`: the unit cost of an item and the carrier's real shipping cost (both are
 * margin data). Those two exist only in the `...WithCost` schemas, so a role without the permission
 * is serialised through a schema in which the key does not exist (zod drops unknown keys).
 */
import { z } from 'zod';

import { moneyDto } from './money';
import { orderStatusValues, paymentStatusValues } from './order';

export const paymentProviderValues = [
  'mono',
  'wayforpay',
  'cod',
  'bank_transfer',
  'gift_card',
] as const;
export const deliveryMethodValues = ['np_warehouse', 'np_courier', 'ukrposhta', 'pickup'] as const;
const operationStateValues = ['pending', 'in_flight', 'succeeded', 'failed', 'unknown'] as const;
const fiscalStatusValues = [
  'not_required',
  'pending',
  'issued',
  'failed',
  'refund_issued',
] as const;

/** One line of the order list. No cost, no address: a list is read at a glance and exported often. */
export const adminOrderRowDto = z.object({
  id: z.uuid(),
  orderNumber: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  status: z.enum(orderStatusValues),
  paymentStatus: z.enum(paymentStatusValues),
  paymentProvider: z.enum(paymentProviderValues).nullable(),
  deliveryMethod: z.enum(deliveryMethodValues),
  customerName: z.string(),
  customerPhone: z.string(),
  customerEmail: z.string(),
  total: moneyDto,
  ttn: z.string().nullable(),
  itemCount: z.number().int(),
});
export type AdminOrderRowDto = z.output<typeof adminOrderRowDto>;

const adminOrderItemFields = {
  id: z.uuid(),
  variantId: z.uuid().nullable(),
  name: z.string(),
  sku: z.string(),
  sizeLabel: z.string(),
  colorName: z.string(),
  unitPrice: moneyDto,
  lineDiscount: moneyDto,
  quantity: z.number().int().positive(),
  lineTotal: moneyDto,
};
export const adminOrderItemDto = z.object(adminOrderItemFields);
export const adminOrderItemWithCostDto = z.object({
  ...adminOrderItemFields,
  unitCostSnapshot: moneyDto.nullable(),
});

export const adminHistoryEntryDto = z.object({
  id: z.uuid(),
  /** `status`, `payment_status` or `note`. */
  field: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  source: z.string(),
  comment: z.string().nullable(),
  byEmail: z.string().nullable(),
  at: z.iso.datetime({ offset: true }),
});

export const adminPaymentEventDto = z.object({
  id: z.uuid(),
  provider: z.string(),
  eventType: z.string().nullable(),
  mappedStatus: z.enum(paymentStatusValues).nullable(),
  amount: moneyDto.nullable(),
  applied: z.boolean(),
  at: z.iso.datetime({ offset: true }),
});

export const adminPaymentAttemptDto = z.object({
  id: z.uuid(),
  attemptNumber: z.number().int(),
  provider: z.string(),
  status: z.enum(paymentStatusValues),
  state: z.enum(operationStateValues),
  amount: moneyDto,
  capturedAmount: moneyDto,
  at: z.iso.datetime({ offset: true }),
});

export const adminRefundDto = z.object({
  id: z.uuid(),
  amount: moneyDto,
  state: z.enum(operationStateValues),
  reason: z.string().nullable(),
  at: z.iso.datetime({ offset: true }),
  settledAt: z.iso.datetime({ offset: true }).nullable(),
});

/** The buttons the order may offer in its current state; the action re-checks every one. */
export const orderActionValues = ['confirm', 'process', 'ship', 'deliver', 'cancel'] as const;

const adminOrderFields = {
  id: z.uuid(),
  orderNumber: z.string(),
  status: z.enum(orderStatusValues),
  paymentStatus: z.enum(paymentStatusValues),
  paymentProvider: z.enum(paymentProviderValues).nullable(),
  fiscalStatus: z.enum(fiscalStatusValues),
  fiscalReceiptUrl: z.string().nullable(),
  customerId: z.uuid().nullable(),
  customerName: z.string(),
  customerPhone: z.string(),
  customerEmail: z.string(),
  deliveryMethod: z.enum(deliveryMethodValues),
  deliverySettlementName: z.string().nullable(),
  deliveryWarehouseName: z.string().nullable(),
  deliveryAddress: z.string().nullable(),
  ttn: z.string().nullable(),
  subtotal: moneyDto,
  discountTotal: moneyDto,
  shippingTotal: moneyDto,
  adjustmentTotal: moneyDto,
  total: moneyDto,
  capturedTotal: moneyDto,
  refundedTotal: moneyDto,
  promoCode: z.string().nullable(),
  locale: z.string(),
  /** What the buyer wrote at checkout. */
  comment: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  paidAt: z.iso.datetime({ offset: true }).nullable(),
  shippedAt: z.iso.datetime({ offset: true }).nullable(),
  deliveredAt: z.iso.datetime({ offset: true }).nullable(),
  cancelledAt: z.iso.datetime({ offset: true }).nullable(),
  history: z.array(adminHistoryEntryDto),
  paymentEvents: z.array(adminPaymentEventDto),
  attempts: z.array(adminPaymentAttemptDto),
  refunds: z.array(adminRefundDto),
  actions: z.array(z.enum(orderActionValues)),
};

export const adminOrderDto = z.object({ ...adminOrderFields, items: z.array(adminOrderItemDto) });
export const adminOrderWithCostDto = z.object({
  ...adminOrderFields,
  shippingCostActual: moneyDto.nullable(),
  items: z.array(adminOrderItemWithCostDto),
});

export type AdminOrderDto = z.output<typeof adminOrderDto>;
export type AdminOrderWithCostDto = z.output<typeof adminOrderWithCostDto>;

/** Serialises an order card for a role: the cost keys only when the role may see them. */
export function serializeAdminOrder(
  value: unknown,
  canSeeCost: boolean,
): AdminOrderDto | AdminOrderWithCostDto {
  return canSeeCost ? adminOrderWithCostDto.parse(value) : adminOrderDto.parse(value);
}
