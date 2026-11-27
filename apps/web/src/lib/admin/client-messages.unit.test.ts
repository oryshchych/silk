import { describe, expect, it } from 'vitest';

import { ROLES } from '@store/core/auth-permissions';

import en from '../../../messages/en.json';
import uk from '../../../messages/uk.json';
import { clientAdminMessages, NAMESPACE_ACCESS } from './client-messages';

describe('client admin messages per visitor', () => {
  it('every namespace of both locales has an access rule (a new section cannot leak by omission)', () => {
    for (const messages of [en, uk]) {
      expect(Object.keys(messages.admin).sort()).toEqual(Object.keys(NAMESPACE_ACCESS).sort());
    }
  });

  it('an anonymous or half-signed-in visitor gets the login flow only, no promo or import text', () => {
    const names = Object.keys(clientAdminMessages(en.admin, null));
    expect(names.sort()).toEqual(['enroll', 'login', 'meta', 'shell', 'verify']);
    const text =
      JSON.stringify(clientAdminMessages(uk.admin, null)) +
      JSON.stringify(clientAdminMessages(en.admin, null));
    expect(text).not.toMatch(/PROMO_LOCKED|excludesGiftCards|exportCsv|cost_price/);
  });

  it.each(ROLES)('%s gets promo and import text only with the permission', (role) => {
    const names = Object.keys(clientAdminMessages(en.admin, role));
    expect(names.includes('promo')).toBe(role !== 'content');
    expect(names.includes('marketing')).toBe(role !== 'content');
    expect(names.includes('importExport')).toBe(role === 'owner' || role === 'admin');
    expect(names).not.toContain('reports');
    expect(names).not.toContain('dashboardReports');
  });
});
