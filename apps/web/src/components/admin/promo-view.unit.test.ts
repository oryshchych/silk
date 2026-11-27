import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { AdminPromoRowDto } from '@store/shared/dto/admin-promo';
import { money } from '@store/shared/money';

import en from '../../../messages/en.json';
import uk from '../../../messages/uk.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../../actions/admin-promo', () => ({
  createPromoCodeAction: vi.fn(),
  updatePromoCodeAction: vi.fn(),
  bulkPromoCodesAction: vi.fn(),
}));

const { PromoForm } = await import('./promo-form');
const { PromoTable } = await import('./promo-table');

const row: AdminPromoRowDto = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'SPRING10',
  description: 'Spring',
  type: 'percent',
  value: 10,
  maxDiscountAmount: money(30_000),
  minOrderTotal: money(0),
  maxUses: 100,
  usesCount: 3,
  perCustomerLimit: null,
  scope: 'all',
  scopeCategoryId: null,
  scopeProductId: null,
  stackable: false,
  excludesDiscountedItems: false,
  firstOrderOnly: false,
  excludesGiftCards: true,
  startsAt: null,
  endsAt: '2030-01-01T10:00:00.000Z',
  isActive: true,
  status: 'active',
  createdAt: '2026-11-01T10:00:00.000Z',
  consumedCount: 3,
  discountTotal: money(1_000),
  netTotal: money(50_000),
  hasRedemptions: true,
};

// next-intl reads the locale from the provider; a missing key renders as its path (`admin.promo.x`).
const render = (locale: 'uk' | 'en', element: ReactElement) =>
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: { admin: (locale === 'uk' ? uk : en).admin },
      children: element,
    }),
  );

describe.each(['uk', 'en'] as const)('promo admin components (%s)', (locale) => {
  const messages = (locale === 'uk' ? uk : en).admin.promo;
  const sortHref = { code: '#', uses: '#', revenue: '#', created: '#', ends: '#' };

  it('the table renders real text and the bulk bar, never a raw key', () => {
    const html = render(
      locale,
      createElement(PromoTable, { rows: [row], canManage: true, sortHref }),
    );
    expect(html).toContain(messages.bulkDeactivate);
    expect(html).toContain(messages.statuses.active);
    expect(html).toContain('SPRING10');
    expect(html).not.toMatch(/admin\.promo\.|MISSING_MESSAGE/);
  });

  it('the table of a manager has no checkboxes and no bulk bar', () => {
    const html = render(
      locale,
      createElement(PromoTable, { rows: [row], canManage: false, sortHref }),
    );
    expect(html).not.toContain(messages.bulkDeactivate);
    expect(html).not.toContain('type="checkbox"');
  });

  it('the form renders its labels, the frozen note for a redeemed code and no raw key', () => {
    const html = render(
      locale,
      createElement(PromoForm, {
        existing: { row, startsAtLocal: '', endsAtLocal: '2030-01-01T12:00' },
        categories: [],
      }),
    );
    expect(html).toContain(messages.frozenNote);
    expect(html).toContain(messages.cap);
    expect(html).toContain(messages.preview);
    expect(html).not.toMatch(/admin\.promo\.|MISSING_MESSAGE/);
  });
});
