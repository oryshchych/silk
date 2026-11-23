import { startPayment, type StartPaymentResult } from '@store/core/start-payment';
import type { ProviderCode } from '@store/core/refunds';
import type { SiteLocale } from '@store/shared/seo';

import { getDb } from './db';
import { getPaymentProviders } from './payment-providers';
import { href, paths } from './paths';
import { getSiteUrl } from './site-url';

/**
 * Opens (or resumes) a card payment for an existing order. The return URL is the order page: it
 * decides what to show from the stored payment status, which only a verified server source
 * changes (AGENTS.md 2.5), so a buyer who types this URL by hand gains nothing.
 */
export async function beginCardPayment(
  orderId: string,
  provider: ProviderCode,
  locale: SiteLocale,
): Promise<StartPaymentResult> {
  const db = await getDb();
  const site = (await getSiteUrl()).replace(/\/$/, '');
  return await startPayment(
    {
      runInTransaction: async (fn) => await db.transaction(async (tx) => await fn(tx)),
      providers: await getPaymentProviders(),
      urls: {
        returnUrl: () => `${site}${href(locale, paths.orderSuccess)}`,
        webhookUrl: (code) => `${site}/api/webhooks/${code}`,
      },
    },
    { orderId, provider },
  );
}
