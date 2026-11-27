/**
 * Newsletter subscription with double opt-in (phase 11, slice C). The consent rules:
 *
 * - a request stores NO consent: it creates (or re-opens) a PENDING row (`confirmed_at` and `unsubscribed_at` both
 *   empty) and may queue one confirmation mail; only the click on that mail's link, which reaches the address's
 *   owner, confirms;
 * - the link is bound to the REQUEST GENERATION (`request_nonce`): every new request, unsubscribe (link or account
 *   toggle) and confirmation rotates it, and the confirm UPDATE compares it, so a consumed link, a link from before an
 *   unsubscribe and a link from an earlier request all stop working. A pending repeat keeps the generation (the mail
 *   in the inbox stays valid) and sends another mail only after an hour (`confirm_mail_queued_at`);
 * - the same statements run for a new, a pending, a subscribed and an unsubscribed address (the answer and the work
 *   do not tell them apart): only the values written and the row counts of the gated outbox and audit inserts differ;
 * - the newsletter consent covers the newsletter ONLY: confirming never switches on `customers.accepts_marketing`,
 *   which gates the cart reminder;
 * - what was agreed to is recorded in the audit row (wording version, source, language; never the address), and only
 *   when a mail is queued or the state changes;
 * - addresses are lower-cased once, here, and the schema forbids upper case (`newsletter_email_lower`).
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Tx } from '@store/db/types';
import { NEWSLETTER_CONSENT_VERSION } from '@store/shared/newsletter';

import { writeAudit } from '../audit/write-audit.ts';
import { readConfirmToken } from './confirm-token.ts';

export const subscribeSchema = z.object({
  email: z
    .string()
    .trim()
    .max(320)
    .transform((value) => value.toLowerCase())
    .pipe(z.email()),
  locale: z.enum(['uk', 'en']),
  /** The box must be ticked: consent is an act, never a default. */
  consent: z.literal(true),
});
export type SubscribeInput = z.output<typeof subscribeSchema>;

export const NEWSLETTER_SOURCES = ['page'] as const;
/** A pending subscriber gets another confirmation mail only this long after the last one. */
export const CONFIRM_MAIL_COOLDOWN_MINUTES = 60;

/** The mailbox behind an address: the plus tag is dropped, so `a+1@x` and `a+2@x` are one mailbox for the limits. */
export function canonicalMailbox(email: string): string {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  return `${local.split('+')[0] ?? local}@${domain}`;
}
export const mailboxDomain = (email: string): string => email.toLowerCase().split('@')[1] ?? '';

interface Row extends Record<string, unknown> {
  id: string;
  request_nonce: string;
  confirmed_at: Date | null;
  unsubscribed_at: Date | null;
  inserted: boolean;
  cooled_down: boolean;
}

/**
 * Creates or re-opens a pending subscription and queues the confirmation mail when one is due. Nothing is
 * confirmed here. Returns whether a mail was queued (for tests: the caller's answer never depends on it).
 */
export async function requestSubscription(
  tx: Tx,
  input: SubscribeInput,
  source: (typeof NEWSLETTER_SOURCES)[number] = 'page',
): Promise<{ queued: boolean }> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`newsletter:${input.email}`}, 0))`,
  );
  // One statement for the insert and the read: a row another transaction (the account page) is inserting is
  // waited for and then updated in place, never a unique violation. The no-op DO UPDATE returns the row.
  const found = await tx.execute<Row>(
    sql`INSERT INTO newsletter_subscribers (email, locale, source)
        VALUES (${input.email}, ${input.locale}, ${source})
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id, request_nonce, confirmed_at, unsubscribed_at, (xmax = 0) AS inserted,
          (confirm_mail_queued_at IS NULL
            OR confirm_mail_queued_at <= now() - make_interval(mins => ${CONFIRM_MAIL_COOLDOWN_MINUTES})) AS cooled_down`,
  );
  const row = found.rows[0];
  if (row === undefined) throw new Error('newsletter subscriber upsert returned no row');
  const active = row.confirmed_at !== null && row.unsubscribed_at === null;
  const reopened = !row.inserted && !active && row.unsubscribed_at !== null;
  const pendingRepeat = !row.inserted && !active && !reopened;
  const queue = row.inserted || reopened || (pendingRepeat && row.cooled_down);
  // Same UPDATE on every path; a path that changes nothing writes the values the row already has.
  await tx.execute(
    sql`UPDATE newsletter_subscribers SET
          confirmed_at = ${reopened ? null : row.confirmed_at}::timestamptz,
          unsubscribed_at = ${reopened ? null : row.unsubscribed_at}::timestamptz,
          request_nonce = CASE WHEN ${reopened}::boolean THEN gen_random_uuid() ELSE request_nonce END,
          locale = CASE WHEN ${reopened}::boolean THEN ${input.locale} ELSE locale END,
          source = CASE WHEN ${reopened}::boolean THEN ${source} ELSE source END,
          confirm_mail_queued_at = CASE WHEN ${queue}::boolean THEN now() ELSE confirm_mail_queued_at END
        WHERE id = ${row.id}::uuid`,
  );
  // The queue row and the audit row are gated in SQL, so every path issues the same two statements.
  await tx.execute(
    sql`INSERT INTO outbox (topic, payload, dedup_key)
        SELECT 'email.newsletter-confirm', jsonb_build_object('subscriberId', s.id::text),
               'newsletter-confirm:' || s.id::text || ':' || s.request_nonce::text || ':' || floor(extract(epoch FROM s.confirm_mail_queued_at) * 1000000)::text
          FROM newsletter_subscribers s WHERE s.id = ${row.id}::uuid AND ${queue}::boolean
        ON CONFLICT DO NOTHING`,
  );
  await tx.execute(
    sql`INSERT INTO audit_log (action, entity, entity_id, diff)
        SELECT 'marketing.subscription_requested', 'newsletter_subscriber', ${row.id},
               jsonb_build_object('source', ${source}::text, 'locale', ${input.locale}::text,
                                  'consentVersion', ${NEWSLETTER_CONSENT_VERSION}::text)
         WHERE ${queue}::boolean`,
  );
  return { queued: queue };
}

export type ConfirmResult = 'confirmed' | 'already' | 'invalid' | 'expired';

/**
 * The click on the mailed link. It confirms a PENDING row of the SAME request generation only. A link of an older
 * generation (consumed, or from before an unsubscribe or a newer request) is `expired` unless the address is
 * subscribed now (then `already`); a forged link is `invalid`.
 */
export async function confirmSubscription(
  tx: Tx,
  secret: string | undefined,
  token: string,
): Promise<ConfirmResult> {
  const read = readConfirmToken(secret, token);
  if (read === null) return 'invalid';
  const live = await tx.execute<{ live: boolean }>(
    sql`SELECT to_timestamp(${read.expires}) > now() AS live`,
  );
  if (live.rows[0]?.live !== true) return 'expired';
  const confirmed = await tx.execute<{ id: string }>(
    sql`UPDATE newsletter_subscribers
           SET confirmed_at = now(), request_nonce = gen_random_uuid()
         WHERE id = ${read.id}::uuid AND request_nonce = ${read.nonce}::uuid
           AND confirmed_at IS NULL AND unsubscribed_at IS NULL
        RETURNING id`,
  );
  if (confirmed.rows[0] === undefined) {
    const now = await tx.execute<{ active: boolean }>(
      sql`SELECT (confirmed_at IS NOT NULL AND unsubscribed_at IS NULL) AS active
            FROM newsletter_subscribers WHERE id = ${read.id}::uuid`,
    );
    return now.rows[0]?.active === true ? 'already' : 'expired';
  }
  await writeAudit(tx, {
    userId: null,
    action: 'marketing.subscription_confirmed',
    entity: 'newsletter_subscriber',
    entityId: read.id,
    diff: { consentVersion: NEWSLETTER_CONSENT_VERSION },
  });
  return 'confirmed';
}

/** What the confirmation mail needs, or null when no mail is due (gone, confirmed, or unsubscribed meanwhile). */
export async function readPendingSubscriber(
  reader: Pick<Tx, 'execute'>,
  subscriberId: string,
): Promise<{ email: string; locale: 'uk' | 'en'; nonce: string } | null> {
  const result = await reader.execute<{ email: string; locale: string; request_nonce: string }>(
    sql`SELECT email, locale, request_nonce FROM newsletter_subscribers
         WHERE id = ${subscriberId}::uuid AND confirmed_at IS NULL AND unsubscribed_at IS NULL`,
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { email: row.email, locale: row.locale === 'en' ? 'en' : 'uk', nonce: row.request_nonce };
}
