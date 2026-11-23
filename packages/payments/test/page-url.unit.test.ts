import { describe, expect, it } from 'vitest';

import { MonoProvider } from '../src/mono/mono-provider.ts';
import { isPaymentPageUrl } from '../src/page-url.ts';
import { WayForPayProvider } from '../src/wayforpay/wayforpay-provider.ts';

describe('isPaymentPageUrl: only https on the provider domain', () => {
  const domains = ['monobank.ua'];

  it('accepts the domain and its subdomains', () => {
    expect(isPaymentPageUrl('https://pay.monobank.ua/x', domains)).toBe(true);
    expect(isPaymentPageUrl('https://monobank.ua/x', domains)).toBe(true);
    expect(isPaymentPageUrl('https://PAY.MONOBANK.UA/x', domains)).toBe(true);
  });

  it('refuses other schemes, other hosts, look-alikes, credentials and garbage', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'http://pay.monobank.ua/x',
      'https://evil.example/x',
      'https://monobank.ua.evil.example/x',
      'https://evilmonobank.ua/x',
      'https://user:pass@pay.monobank.ua/x',
      '//pay.monobank.ua/x',
      'not a url',
      '',
    ]) {
      expect(isPaymentPageUrl(url, domains), url).toBe(false);
    }
  });

  it('the adapters accept their own domain plus configured hosts only', () => {
    const mono = new MonoProvider({ baseUrl: 'https://api.monobank.ua', token: 't' });
    expect(mono.isPaymentPage('https://pay.monobank.ua/i/1')).toBe(true);
    expect(mono.isPaymentPage('https://secure.wayforpay.com/x')).toBe(false);
    const wfp = new WayForPayProvider({
      baseUrl: 'https://api.wayforpay.com',
      merchantAccount: 'm',
      secretKey: 's',
      merchantDomainName: 'd',
      pageHosts: ['sandbox.example'],
    });
    expect(wfp.isPaymentPage('https://secure.wayforpay.com/invoice/1')).toBe(true);
    expect(wfp.isPaymentPage('https://sandbox.example/x')).toBe(true);
    expect(wfp.isPaymentPage('https://pay.monobank.ua/x')).toBe(false);
  });
});
