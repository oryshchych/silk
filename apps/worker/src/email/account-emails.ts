/**
 * `email.account-verify` and `email.password-reset`. The queue message carries the token ROW ID
 * only; the address and the language come from the database, and the link is rebuilt from the id
 * with the key derived from `AUTH_SECRET` (nothing that works as a credential is queued or stored).
 * A link that was already used, replaced by a newer one or has expired is not mailed (a retried
 * job after the buyer finished must not send a dead link).
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { buildEmailToken } from '@store/core/customer-token';
import { authEmailTokens, authUsers } from '@store/db/schema';
import type { Reader } from '@store/db/types';

import type { EmailSender } from './resend.ts';
import { escapeHtml, shell, type EmailLocale, type RenderedEmail } from './templates.ts';

const payload = z.object({ tokenId: z.uuid() }).strict();

export class AccountEmailError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AccountEmailError';
  }
}

const COPY = {
  uk: {
    verifySubject: 'Підтвердіть пошту й задайте пароль',
    verifyText:
      'Щоб завершити реєстрацію, підтвердіть адресу й задайте пароль за посиланням (діє 24 години).',
    resetSubject: 'Новий пароль',
    resetText:
      'Щоб задати новий пароль, скористайтесь посиланням (діє 1 годину). Якщо ви вже маєте акаунт, це посилання допоможе до нього увійти.',
    action: 'Задати пароль',
    ignore: 'Якщо ви цього не запитували, просто проігноруйте цей лист: нічого не зміниться.',
  },
  en: {
    verifySubject: 'Confirm your email and set a password',
    verifyText:
      'To finish signing up, confirm your address and set a password with the link below (valid for 24 hours).',
    resetSubject: 'Set a new password',
    resetText:
      'To set a new password, use the link below (valid for 1 hour). If you already have an account, this link lets you back in.',
    action: 'Set password',
    ignore: 'If you did not ask for this, ignore this email: nothing will change.',
  },
} as const;

export function renderAccountLink(input: {
  locale: EmailLocale;
  purpose: 'verify_email' | 'reset_password';
  url: string;
}): RenderedEmail {
  const c = COPY[input.locale];
  const subject = input.purpose === 'verify_email' ? c.verifySubject : c.resetSubject;
  const body = input.purpose === 'verify_email' ? c.verifyText : c.resetText;
  const text = [body, '', input.url, '', c.ignore].join('\n');
  const content = [
    `<p>${escapeHtml(body)}</p>`,
    `<p><a href="${escapeHtml(input.url)}">${escapeHtml(c.action)}</a></p>`,
    `<p class="muted" style="color:#555555">${escapeHtml(c.ignore)}</p>`,
  ].join('');
  return { subject, html: shell({ lang: input.locale, title: subject, content }), text };
}

export async function handleAccountLink(
  deps: {
    reader: Reader;
    sender: EmailSender;
    siteUrl: string;
    authSecret: string | undefined;
  },
  message: { dedupKey: string; payload: unknown },
): Promise<void> {
  const parsed = payload.safeParse(message.payload);
  if (!parsed.success) throw new AccountEmailError('malformed payload');
  const [row] = await deps.reader
    .select({
      purpose: authEmailTokens.purpose,
      locale: authEmailTokens.locale,
      email: authUsers.email,
    })
    .from(authEmailTokens)
    .innerJoin(authUsers, eq(authUsers.id, authEmailTokens.userId))
    .where(
      and(
        eq(authEmailTokens.id, parsed.data.tokenId),
        sql`${authEmailTokens.usedAt} IS NULL`,
        sql`${authEmailTokens.expiresAt} > now()`,
      ),
    );
  if (row === undefined) return;
  // Throws without a strong secret: the job fails and stays in the dead-letter queue, visible.
  const token = buildEmailToken(deps.authSecret, parsed.data.tokenId);
  const locale: EmailLocale = row.locale === 'en' ? 'en' : 'uk';
  const prefix = locale === 'en' ? '/en' : '';
  const url = `${deps.siteUrl.replace(/\/+$/, '')}${prefix}/account/set-password?t=${encodeURIComponent(token)}`;
  await deps.sender.send({
    to: row.email,
    ...renderAccountLink({ locale, purpose: row.purpose, url }),
    idempotencyKey: `${message.dedupKey}:customer`,
  });
}
