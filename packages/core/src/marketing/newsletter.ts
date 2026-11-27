/**
 * Newsletter subscription with double opt-in (phase 11, slice C). The consent rules:
 *
 * - a request stores NO consent: it creates (or re-opens) a PENDING row (`confirmed_at` empty) and queues one
 *   confirmation mail; only the click on that mail's link, which reaches the address's owner, confirms;
 * - the answer to a request is the same whether the address is new, pending, subscribed or was unsubscribed
 *   (nobody learns who is subscribed), and a hostile caller cannot mail a stranger more than once an hour
 *   (the outbox dedup key carries the hour);
 * - the confirmation link is single purpose, expires after 48 hours, and confirms a PENDING row only: an old
 *   link cannot re-subscribe someone who unsubscribed since;
 * - what was agreed to is recorded in the audit row: the consent wording version, the source and the language
 *   (never the address); `newsletter_subscribers.confirmed_at` is the consent time, `unsubscribed_at` its end;
 * - addresses are lower-cased once, here: `customers.email` is lower-cased by a CHECK and the cart reminder joins
 *   on it.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { outbox } from '@store/db/schema';
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

/** Creates or re-opens a pending subscription and queues the confirmation mail. Nothing is confirmed here. */
export async function requestSubscription(
  tx: Tx,
  input: SubscribeInput,
  source: (typeof NEWSLETTER_SOURCES)[number] = 'page',
): Promise<{ queued: boolean }> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`newsletter:${input.email}`}, 0))`,
  );
  const existing = await tx.execute<{ id: string; active: boolean }>(
    sql`SELECT id, (confirmed_at IS NOT NULL AND unsubscribed_at IS NULL) AS active
          FROM newsletter_subscribers WHERE email = ${input.email}`,
  );
  const row = existing.rows[0];
  // Already subscribed: nothing to confirm, no mail, and the caller is told nothing different.
  if (row?.active === true) return { queued: false };
  let id = row?.id;
  if (id === undefined) {
    const created = await tx.execute<{ id: string }>(
      sql`INSERT INTO newsletter_subscribers (email, locale, source)
          VALUES (${input.email}, ${input.locale}, ${source}) RETURNING id`,
    );
    id = created.rows[0]?.id;
  } else {
    // Pending, or unsubscribed and asking again: back to pending (the consent must be given anew).
    await tx.execute(
      sql`UPDATE newsletter_subscribers SET confirmed_at = NULL, locale = ${input.locale}, source = ${source}
           WHERE id = ${id}::uuid`,
    );
  }
  if (id === undefined) throw new Error('newsletter subscriber insert returned no row');
  // One confirmation mail per subscriber per hour, whoever asks: the hour is the database's.
  const bucket = await tx.execute<{ hour: string }>(
    sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24') AS hour`,
  );
  await tx
    .insert(outbox)
    .values({
      topic: 'email.newsletter-confirm',
      payload: { subscriberId: id },
      dedupKey: `newsletter-confirm:${id}:${bucket.rows[0]?.hour ?? ''}`,
    })
    .onConflictDoNothing();
  await writeAudit(tx, {
    userId: null,
    action: 'marketing.subscription_requested',
    entity: 'newsletter_subscriber',
    entityId: id,
    diff: { source, locale: input.locale, consentVersion: NEWSLETTER_CONSENT_VERSION },
  });
  return { queued: true };
}

export type ConfirmResult = 'confirmed' | 'already' | 'invalid' | 'expired';

/** The click on the mailed link. Confirms a PENDING row only; a replay is `already`, a forged link `invalid`. */
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
  const confirmed = await tx.execute<{ email: string }>(
    sql`UPDATE newsletter_subscribers SET confirmed_at = now(), unsubscribed_at = NULL
         WHERE id = ${read.id}::uuid AND confirmed_at IS NULL RETURNING email`,
  );
  const email = confirmed.rows[0]?.email;
  if (email === undefined) return 'already';
  await tx.execute(sql`UPDATE customers SET accepts_marketing = true WHERE email = ${email}`);
  await writeAudit(tx, {
    userId: null,
    action: 'marketing.subscription_confirmed',
    entity: 'newsletter_subscriber',
    entityId: read.id,
    diff: { consentVersion: NEWSLETTER_CONSENT_VERSION },
  });
  return 'confirmed';
}

/** What the confirmation mail needs, or null when no mail is due (gone, or already confirmed). */
export async function readPendingSubscriber(
  reader: Pick<Tx, 'execute'>,
  subscriberId: string,
): Promise<{ email: string; locale: 'uk' | 'en' } | null> {
  const result = await reader.execute<{ email: string; locale: string }>(
    sql`SELECT email, locale FROM newsletter_subscribers WHERE id = ${subscriberId}::uuid AND confirmed_at IS NULL`,
  );
  const row = result.rows[0];
  return row === undefined ? null : { email: row.email, locale: row.locale === 'en' ? 'en' : 'uk' };
}
