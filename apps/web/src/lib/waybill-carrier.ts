import { NovaPoshtaWaybill } from '@store/payments/nova-poshta';
import type { WaybillCarrier } from '@store/payments/shipping';

import { runtimeEnv } from './runtime-env';

declare global {
  var silkWaybillCarrier: WaybillCarrier | null | undefined;
}

/**
 * The Nova Poshta waybill adapter, built on first use. Without the key there is no carrier
 * (null): the action then says "not configured" and nothing is sent anywhere.
 */
export async function getWaybillCarrier(): Promise<WaybillCarrier | null> {
  if (globalThis.silkWaybillCarrier !== undefined) return globalThis.silkWaybillCarrier;
  const env = await runtimeEnv();
  globalThis.silkWaybillCarrier =
    env.NOVA_POSHTA_API_KEY === undefined
      ? null
      : new NovaPoshtaWaybill({
          apiKey: env.NOVA_POSHTA_API_KEY,
          baseUrl: env.NOVA_POSHTA_API_BASE_URL ?? 'https://api.novaposhta.ua/v2.0/json/',
          printBaseUrl: env.NOVA_POSHTA_PRINT_BASE_URL ?? 'https://my.novaposhta.ua',
        });
  return globalThis.silkWaybillCarrier;
}
