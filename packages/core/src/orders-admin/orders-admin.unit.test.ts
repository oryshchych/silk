import { describe, expect, it } from 'vitest';

import {
  adminOrderDto,
  adminOrderWithCostDto,
  serializeAdminOrder,
} from '@store/shared/dto/admin-order';

import { availableActions } from './read.ts';
import { cancelOrderSchema, confirmTransferSchema, orderNoteSchema } from './schemas.ts';

const id = '00000000-0000-4000-8000-000000000001';

describe('availableActions', () => {
  it('offers only what the state allows', () => {
    const base = { paymentProvider: 'mono' as const };
    expect(availableActions({ ...base, status: 'pending', paymentStatus: 'pending' })).toEqual([
      'cancel',
    ]);
    expect(availableActions({ ...base, status: 'pending', paymentStatus: 'paid' })).toEqual([
      'confirm',
      'ship',
      'cancel',
    ]);
    expect(availableActions({ ...base, status: 'confirmed', paymentStatus: 'paid' })).toEqual([
      'process',
      'ship',
      'cancel',
    ]);
    expect(availableActions({ ...base, status: 'shipped', paymentStatus: 'paid' })).toEqual([
      'deliver',
    ]);
    for (const status of ['delivered', 'cancelled', 'returned'] as const) {
      expect(availableActions({ ...base, status, paymentStatus: 'paid' })).toEqual([]);
    }
  });

  it('a COD order is confirmed by the manager, then ships without a payment status', () => {
    const cod = { paymentProvider: 'cod' as const, paymentStatus: 'pending' };
    expect(availableActions({ ...cod, status: 'pending' })).toEqual(['confirm', 'cancel']);
    expect(availableActions({ ...cod, status: 'confirmed' })).toEqual([
      'process',
      'ship',
      'cancel',
    ]);
  });
});

describe('schemas', () => {
  it('require a real reason for a cancellation', () => {
    expect(cancelOrderSchema.safeParse({ orderId: id, reason: 'customer called' }).success).toBe(
      true,
    );
    for (const reason of [undefined, '', '  ', 'ab', 'x'.repeat(501), 'a\u0000bc']) {
      expect(cancelOrderSchema.safeParse({ orderId: id, reason }).success, String(reason)).toBe(
        false,
      );
    }
  });

  it('bound notes and bank references, and turn the amount into whole kopiykas', () => {
    expect(orderNoteSchema.safeParse({ orderId: id, text: '' }).success).toBe(false);
    const parsed = confirmTransferSchema.parse({
      orderId: id,
      bankReference: 'R1',
      amount: '1299.50',
    });
    expect(parsed.amount).toBe(129950);
    expect(
      confirmTransferSchema.safeParse({ orderId: id, bankReference: 'R1', amount: '12,99x' })
        .success,
    ).toBe(false);
  });
});

describe('order DTO', () => {
  const order = {
    id,
    orderNumber: 'LS-2026-000001',
    status: 'pending',
    paymentStatus: 'pending',
    paymentProvider: 'cod',
    fiscalStatus: 'not_required',
    fiscalReceiptUrl: null,
    customerId: null,
    customerName: 'A',
    customerPhone: '+380501112233',
    customerEmail: 'a@b.co',
    deliveryMethod: 'pickup',
    deliverySettlementName: null,
    deliveryWarehouseName: null,
    deliveryAddress: null,
    ttn: null,
    subtotal: 100,
    discountTotal: 0,
    shippingTotal: 0,
    adjustmentTotal: 0,
    total: 100,
    capturedTotal: 0,
    refundedTotal: 0,
    promoCode: null,
    locale: 'uk',
    comment: null,
    createdAt: '2026-11-26T10:00:00.000Z',
    paidAt: null,
    shippedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    history: [],
    paymentEvents: [],
    attempts: [],
    refunds: [],
    actions: [],
    shippingCostActual: 4242,
    ip: '198.51.100.7',
    accessTokenHash: 'h',
    items: [
      {
        id,
        variantId: null,
        name: 'n',
        sku: 's',
        sizeLabel: 'S',
        colorName: 'c',
        unitPrice: 100,
        lineDiscount: 0,
        quantity: 1,
        lineTotal: 100,
        unitCostSnapshot: 777700,
      },
    ],
  };
  it('drops the cost keys for a role without the permission, and the secrets for everyone', () => {
    const plain = JSON.stringify(serializeAdminOrder(order, false));
    const withCost = JSON.stringify(serializeAdminOrder(order, true));
    expect(plain).not.toMatch(/unitCostSnapshot|shippingCostActual|777700|4242/);
    expect(withCost).toContain('"unitCostSnapshot":777700');
    for (const json of [plain, withCost]) expect(json).not.toMatch(/198\.51|accessTokenHash/);
    expect(adminOrderDto.safeParse(order).success).toBe(true);
    expect(
      adminOrderWithCostDto.safeParse({ ...order, shippingCostActual: undefined }).success,
    ).toBe(false);
  });
});
