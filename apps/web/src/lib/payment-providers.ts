import type { ProviderMap } from '@store/core/refunds';
import { MonoProvider } from '@store/payments/mono';
import { WayForPayProvider } from '@store/payments/wayforpay';

import { runtimeEnv } from './runtime-env';

declare global {
  // One adapter set per process: the Mono adapter caches the merchant public key.
  var silkPaymentProviders: ProviderMap | undefined;
}

/**
 * The configured payment adapters, built on first use from the validated environment. A provider
 * without its credentials is simply absent (and then refused, never guessed): staging runs with
 * none until the sandboxes exist.
 */
export async function getPaymentProviders(): Promise<ProviderMap> {
  if (globalThis.silkPaymentProviders !== undefined) return globalThis.silkPaymentProviders;
  const env = await runtimeEnv();
  const pageHosts = (env.PAYMENT_PAGE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
  const providers: ProviderMap = {};
  if (env.MONO_PLATA_TOKEN !== undefined) {
    providers.mono = new MonoProvider({
      baseUrl: env.MONO_API_BASE_URL ?? 'https://api.monobank.ua',
      token: env.MONO_PLATA_TOKEN,
      pageHosts,
    });
  }
  if (env.WAYFORPAY_MERCHANT_ACCOUNT !== undefined && env.WAYFORPAY_SECRET_KEY !== undefined) {
    const site = env.SITE_URL ?? env.NEXT_PUBLIC_SITE_URL;
    const domain = env.WAYFORPAY_MERCHANT_DOMAIN ?? (site === undefined ? '' : new URL(site).host);
    if (domain !== '') {
      providers.wayforpay = new WayForPayProvider({
        baseUrl: env.WAYFORPAY_API_BASE_URL ?? 'https://api.wayforpay.com',
        merchantAccount: env.WAYFORPAY_MERCHANT_ACCOUNT,
        secretKey: env.WAYFORPAY_SECRET_KEY,
        merchantDomainName: domain,
        pageHosts,
      });
    }
  }
  globalThis.silkPaymentProviders = providers;
  return providers;
}
