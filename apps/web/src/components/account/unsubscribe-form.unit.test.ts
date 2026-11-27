import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';
import uk from '../../../messages/uk.json';

vi.mock('@/actions/unsubscribe', () => ({
  unsubscribeMarketingAction: vi.fn(),
  unsubscribeStockAlertAction: vi.fn(),
}));
const { UnsubscribeForm } = await import('./unsubscribe-form');

describe.each(['uk', 'en'] as const)('UnsubscribeForm (%s)', (locale) => {
  it('renders the real button text, never a raw key', () => {
    const messages = locale === 'uk' ? uk : en;
    const html = renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale,
        messages: { account: messages.account },
        children: createElement(UnsubscribeForm, { token: 't', marketing: true }),
      }),
    );
    expect(html).toContain(messages.account.unsubscribeConfirm);
    expect(html).not.toMatch(/account\.|MISSING_MESSAGE/);
    expect(messages.account.marketingUnsubscribeIntro.length).toBeGreaterThan(10);
  });
});
