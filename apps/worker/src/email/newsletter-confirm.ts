/**
 * `email.newsletter-confirm`: the double opt-in mail. The queue message carries the subscriber id only; the
 * address and language come from the database at send time, a subscriber who confirmed meanwhile (or was
 * removed) gets nothing, and the confirmation link (48 hours, single purpose) is minted here under a key
 * derived from `AUTH_SECRET`. Nothing is subscribed by sending this: only the click confirms.
 */
import { z } from 'zod';

import { buildConfirmToken, readPendingSubscriber } from '@store/core/marketing';
import type { Reader } from '@store/db/types';

import type { EmailSender } from './resend.ts';
import { escapeHtml, shell, type EmailLocale, type RenderedEmail } from './templates.ts';

const payload = z.object({ subscriberId: z.uuid() }).strict();

export class NewsletterConfirmEmailError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NewsletterConfirmEmailError';
  }
}

const COPY = {
  uk: {
    subject: 'Підтвердіть підписку на розсилку Damazla',
    intro: 'Ви (або хтось за вашою адресою) попросили надсилати вам новини Damazla.',
    action: 'Підтвердити підписку',
    ignore:
      'Якщо це були не ви, просто проігноруйте цей лист: без підтвердження ми нічого не надсилаємо. Посилання діє 48 годин.',
  },
  en: {
    subject: 'Confirm your Damazla newsletter subscription',
    intro: 'You (or someone using your address) asked to receive Damazla news.',
    action: 'Confirm subscription',
    ignore:
      'If this was not you, ignore this email: without the confirmation we send nothing. The link works for 48 hours.',
  },
} as const;

export function renderNewsletterConfirm(input: {
  locale: EmailLocale;
  confirmUrl: string;
}): RenderedEmail {
  const c = COPY[input.locale];
  const text = [c.intro, '', `${c.action}: ${input.confirmUrl}`, '', c.ignore].join('\n');
  const content = [
    `<p>${escapeHtml(c.intro)}</p>`,
    `<p><a href="${escapeHtml(input.confirmUrl)}">${escapeHtml(c.action)}</a></p>`,
    `<p class="muted" style="color:#555555">${escapeHtml(c.ignore)}</p>`,
  ].join('');
  return {
    subject: c.subject,
    html: shell({ lang: input.locale, title: c.subject, content }),
    text,
  };
}

export async function handleNewsletterConfirm(
  deps: { reader: Reader; sender: EmailSender; siteUrl: string; authSecret: string | undefined },
  message: { dedupKey: string; payload: unknown },
): Promise<void> {
  const parsed = payload.safeParse(message.payload);
  if (!parsed.success) throw new NewsletterConfirmEmailError('malformed payload');
  const pending = await readPendingSubscriber(deps.reader, parsed.data.subscriberId);
  if (pending === null) return;
  // Throws without a strong secret: the job fails into the dead-letter queue, nothing is sent.
  const token = buildConfirmToken(deps.authSecret, parsed.data.subscriberId);
  const base = deps.siteUrl.replace(/\/+$/, '');
  const prefix = pending.locale === 'en' ? '/en' : '';
  await deps.sender.send({
    to: pending.email,
    ...renderNewsletterConfirm({
      locale: pending.locale,
      confirmUrl: `${base}${prefix}/newsletter/confirm?t=${encodeURIComponent(token)}`,
    }),
    idempotencyKey: `${message.dedupKey}:subscriber`,
  });
}
