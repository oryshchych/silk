import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { NEWSLETTER_CONSENT_VERSION } from '@store/shared/newsletter';

import en from '../../../messages/en.json';
import uk from '../../../messages/uk.json';
import { isAccountPath } from '../../lib/account-path';

vi.mock('@/actions/unsubscribe', () => ({
  subscribeNewsletterAction: vi.fn(),
  confirmNewsletterAction: vi.fn(),
}));
const { SubscribeForm } = await import('./subscribe-form');
const { ConfirmForm } = await import('./confirm-form');

const render = (locale: 'uk' | 'en', element: ReactElement) =>
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: { newsletter: (locale === 'uk' ? uk : en).newsletter },
      children: element,
    }),
  );

describe.each(['uk', 'en'] as const)('newsletter components (%s)', (locale) => {
  const messages = (locale === 'uk' ? uk : en).newsletter;
  it('the form shows the consent wording, an unticked box and a hidden honeypot, never a raw key', () => {
    const html = render(locale, createElement(SubscribeForm));
    expect(html).toContain(messages.consent);
    expect(html).toContain(messages.submit);
    expect(html).not.toMatch(/checked/);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/newsletter\.|MISSING_MESSAGE/);
  });
  it('the confirm page button shows real text', () => {
    const html = render(locale, createElement(ConfirmForm, { token: 't' }));
    expect(html).toContain(messages.confirmButton);
    expect(html).not.toMatch(/newsletter\.|MISSING_MESSAGE/);
  });
  it('the consent wording version in the messages is the one the audit row records', () => {
    expect(messages.consentVersion).toBe(NEWSLETTER_CONSENT_VERSION);
  });
});

describe('the newsletter paths are private like the account', () => {
  it.each(['/newsletter', '/en/newsletter', '/newsletter/confirm', '/en/newsletter/confirm/'])(
    '%s',
    (path) => {
      expect(isAccountPath(path)).toBe(true);
    },
  );
  it('the shop pages are not', () => {
    expect(isAccountPath('/category/bras')).toBe(false);
  });
});
