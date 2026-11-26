/**
 * `email.back-in-stock`: one mail per alert. The queue message carries the alert id only; the address,
 * the product and the size come from the database when the mail is sent, and the unsubscribe link is
 * rebuilt from the id (signed under a derived key). An alert that was removed meanwhile sends nothing.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { buildUnsubscribeToken } from '@store/core/account-alerts';
import type { Reader } from '@store/db/types';

import type { EmailSender } from './resend.ts';
import { escapeHtml, oneLine, shell, type EmailLocale, type RenderedEmail } from './templates.ts';

const payload = z.object({ alertId: z.uuid() }).strict();

export class BackInStockEmailError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BackInStockEmailError';
  }
}

const COPY = {
  uk: {
    subject: (product: string) => `${product} знову в наявності`,
    text: (product: string, size: string) =>
      `Розмір ${size} товару «${product}» знову можна замовити.`,
    open: 'Відкрити товар',
    stop: 'Більше не повідомляти про цей розмір',
  },
  en: {
    subject: (product: string) => `${product} is back in stock`,
    text: (product: string, size: string) => `Size ${size} of "${product}" can be ordered again.`,
    open: 'Open the product',
    stop: 'Stop notifying me about this size',
  },
} as const;

export function renderBackInStock(input: {
  locale: EmailLocale;
  product: string;
  size: string;
  productUrl: string;
  unsubscribeUrl: string;
}): RenderedEmail {
  const c = COPY[input.locale];
  const product = oneLine(input.product);
  const subject = c.subject(product);
  const text = [
    c.text(product, input.size),
    '',
    input.productUrl,
    '',
    `${c.stop}: ${input.unsubscribeUrl}`,
  ].join('\n');
  const content = [
    `<p>${escapeHtml(c.text(product, input.size))}</p>`,
    `<p><a href="${escapeHtml(input.productUrl)}">${escapeHtml(c.open)}</a></p>`,
    `<p class="muted" style="color:#555555"><a href="${escapeHtml(input.unsubscribeUrl)}">${escapeHtml(c.stop)}</a></p>`,
  ].join('');
  return { subject, html: shell({ lang: input.locale, title: subject, content }), text };
}

export async function handleBackInStock(
  deps: { reader: Reader; sender: EmailSender; siteUrl: string; authSecret: string | undefined },
  message: { dedupKey: string; payload: unknown },
): Promise<void> {
  const parsed = payload.safeParse(message.payload);
  if (!parsed.success) throw new BackInStockEmailError('malformed payload');
  const result = await deps.reader.execute<{
    email: string;
    locale: string;
    slug: string;
    name_uk: string;
    name_en: string;
    size: string;
  }>(
    sql`SELECT n.email, n.locale, p.slug, p.name_uk, p.name_en, s.label AS size
          FROM stock_notifications n
          JOIN product_variants v ON v.id = n.variant_id
          JOIN products p ON p.id = v.product_id
          JOIN sizes s ON s.id = v.size_id
         WHERE n.id = ${parsed.data.alertId}::uuid`,
  );
  const row = result.rows[0];
  if (row === undefined) return;
  // Throws without a strong secret: the job fails into the dead-letter queue, nothing is sent.
  const token = buildUnsubscribeToken(deps.authSecret, parsed.data.alertId);
  const locale: EmailLocale = row.locale === 'en' ? 'en' : 'uk';
  const base = deps.siteUrl.replace(/\/+$/, '');
  const prefix = locale === 'en' ? '/en' : '';
  await deps.sender.send({
    to: row.email,
    ...renderBackInStock({
      locale,
      product: locale === 'en' ? row.name_en : row.name_uk,
      size: row.size,
      productUrl: `${base}${prefix}/product/${encodeURIComponent(row.slug)}`,
      unsubscribeUrl: `${base}${prefix}/unsubscribe?t=${encodeURIComponent(token)}`,
    }),
    idempotencyKey: `${message.dedupKey}:customer`,
  });
}
