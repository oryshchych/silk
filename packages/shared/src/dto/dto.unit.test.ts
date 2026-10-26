/**
 * Тестується ФАКТИЧНА серіалізована відповідь, а не те, що видно в UI
 * (AGENTS.md §4b.3): на вхід — рядок із БД з усіма службовими полями.
 */
import { describe, expect, it } from 'vitest';

import { productCardDto } from './catalog';
import { customerOrderDto } from './order';
import { serialize } from './serialize';

const productRow = {
  id: '0193f0a4-7c3e-7000-8000-000000000001',
  slug: 'lace-bra-aurora-1',
  name: 'Мереживний бюстгальтер «Аврора»',
  brand: 'Aurelia',
  price: 129900,
  compareAtPrice: null,
  badge: 'none',
  ratingAvg: 4.5,
  reviewsCount: 2,
  inStock: true,
  // Службове — не мусить вийти назовні:
  costPrice: 58455,
  isActive: false,
  searchVector: "'аврор':2",
};

const orderRow = {
  orderNumber: 'LS-2026-000042',
  status: 'delivered',
  paymentStatus: 'paid',
  createdAt: '2026-10-26T10:00:00.000Z',
  subtotal: 259800,
  discountTotal: 25980,
  shippingTotal: 0,
  total: 233820,
  ttn: '20451000000042',
  adminNote: 'клієнтка просила дзвонити після 18:00',
  ip: '203.0.113.7',
  items: [
    {
      name: 'Бралет «Мрія»',
      sku: 'LS-BRA-003-BLACK-75B',
      sizeLabel: '75B',
      colorName: 'Чорний',
      unitPrice: 129900,
      quantity: 2,
      lineDiscount: 25980,
      lineTotal: 233820,
      unitCostSnapshot: 61000,
    },
  ],
};

const keysDeep = (value: unknown): string[] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)])
    : [];

describe('productCardDto', () => {
  it('віддає лише перелічені поля', () => {
    const dto = serialize(productCardDto, productRow);
    expect(Object.keys(dto).sort()).toEqual([
      'badge',
      'brand',
      'compareAtPrice',
      'id',
      'inStock',
      'name',
      'price',
      'ratingAvg',
      'reviewsCount',
      'slug',
    ]);
    expect(JSON.stringify(dto)).not.toMatch(/cost|isActive|searchVector/i);
  });

  it('нецілі копійки — помилка, а не округлення', () => {
    expect(() => serialize(productCardDto, { ...productRow, price: 1299.5 })).toThrow();
  });
});

describe('customerOrderDto', () => {
  it('не пропускає службових полів ні на замовленні, ні у вкладених позиціях', () => {
    const json = JSON.stringify(serialize(customerOrderDto, orderRow));
    const keys = keysDeep(JSON.parse(json));
    expect(keys).not.toContain('unitCostSnapshot');
    expect(keys).not.toContain('adminNote');
    expect(keys).not.toContain('ip');
    expect(json).not.toContain('61000');
    expect(json).not.toContain('203.0.113.7');
  });

  it('суми лишаються цілими копійками в JSON', () => {
    const dto = serialize(customerOrderDto, orderRow);
    expect(dto.total).toBe(233820);
    expect(dto.items[0]?.lineTotal).toBe(233820);
  });
});
