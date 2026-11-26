/**
 * The customer's profile: name, phone, language, saved sizes and the newsletter choice. Scoped by
 * the customer id of the session; every write also writes `audit_log` in the same transaction with
 * the account as the author. The newsletter choice is a CONSENT: the row records when and from where
 * it was given (`confirmed_at`, `source`), and the history of changes stays in the audit log.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { customers, newsletterSubscribers, sizes } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { profileDto, type ProfileDto } from '@store/shared/dto/account';
import { serialize } from '@store/shared/dto/serialize';
import { normalizeUaPhone } from '@store/shared/phone';

import { writeAudit } from '../audit/write-audit.ts';

const name = z
  .string()
  .trim()
  .max(120)
  .refine((value) => !/[\u0000-\u001f]/.test(value), 'no control characters')
  .transform((value) => (value === '' ? null : value));

export const updateProfileSchema = z.object({
  firstName: name,
  lastName: name,
  phone: z
    .string()
    .trim()
    .max(40)
    .refine(
      (value) => value === '' || normalizeUaPhone(value) !== null,
      'phone is not a Ukrainian number',
    )
    .transform((value) => (value === '' ? null : normalizeUaPhone(value))),
  locale: z.enum(['uk', 'en']),
});
export type UpdateProfileInput = z.output<typeof updateProfileSchema>;

export async function getProfile(reader: Reader, customerId: string): Promise<ProfileDto | null> {
  const [row] = await reader
    .select({
      email: customers.email,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      locale: customers.locale,
      acceptsMarketing: customers.acceptsMarketing,
      braSizeId: customers.preferredBraSizeId,
      apparelSizeId: customers.preferredApparelSizeId,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  return row === undefined
    ? null
    : serialize(profileDto, { ...row, locale: row.locale === 'en' ? 'en' : 'uk' });
}

interface Who {
  customerId: string;
  userId: string;
  ip: string | null;
}

export async function updateProfile(tx: Tx, who: Who, input: UpdateProfileInput): Promise<void> {
  await tx
    .update(customers)
    .set({
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone ?? null,
      locale: input.locale,
    })
    .where(eq(customers.id, who.customerId));
  // Names and the phone are personal data: the audit row says WHAT changed, never the values.
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.profile_updated',
    entity: 'customer',
    entityId: who.customerId,
    diff: { fields: ['firstName', 'lastName', 'phone', 'locale'] },
    ip: who.ip,
  });
}

export class SizeNotFoundError extends Error {
  constructor() {
    super('size does not exist or is of another system');
    this.name = 'SizeNotFoundError';
  }
}

/** Saved sizes: a bra size must be of the `bra` system and an apparel size of `apparel`; null clears. */
export async function setMySizes(
  tx: Tx,
  who: Who,
  input: { braSizeId: string | null; apparelSizeId: string | null },
): Promise<void> {
  for (const [id, system] of [
    [input.braSizeId, 'bra'],
    [input.apparelSizeId, 'apparel'],
  ] as const) {
    if (id === null) continue;
    const [size] = await tx
      .select({ id: sizes.id })
      .from(sizes)
      .where(and(eq(sizes.id, id), eq(sizes.system, system)));
    if (size === undefined) throw new SizeNotFoundError();
  }
  await tx
    .update(customers)
    .set({ preferredBraSizeId: input.braSizeId, preferredApparelSizeId: input.apparelSizeId })
    .where(eq(customers.id, who.customerId));
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.sizes_updated',
    entity: 'customer',
    entityId: who.customerId,
    ip: who.ip,
  });
}

/**
 * Subscribes or unsubscribes the account's own address. The address is verified (the account
 * exists), so a subscription is confirmed at once; the time and the source are recorded.
 * Returns false when nothing changed (a repeat records nothing twice).
 */
export async function setNewsletter(
  tx: Tx,
  who: Who,
  input: { subscribe: boolean },
): Promise<boolean> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer:${who.customerId}`}, 0))`,
  );
  const [customer] = await tx
    .select({ email: customers.email, locale: customers.locale, on: customers.acceptsMarketing })
    .from(customers)
    .where(eq(customers.id, who.customerId));
  if (customer === undefined) return false;
  // `newsletter_subscribers` is the source of truth (the future mailer reads it); the flag on the
  // customer mirrors it. Nothing is skipped unless BOTH already say what was asked.
  const [subscriber] = await tx
    .select({
      active: sql<boolean>`${newsletterSubscribers.confirmedAt} IS NOT NULL AND ${newsletterSubscribers.unsubscribedAt} IS NULL`,
    })
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, customer.email));
  if (customer.on === input.subscribe && (subscriber?.active ?? false) === input.subscribe)
    return false;
  await tx
    .update(customers)
    .set({ acceptsMarketing: input.subscribe })
    .where(eq(customers.id, who.customerId));
  if (input.subscribe) {
    await tx
      .insert(newsletterSubscribers)
      .values({
        email: customer.email,
        locale: customer.locale,
        source: 'account',
        confirmedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: newsletterSubscribers.email,
        set: {
          confirmedAt: sql`now()`,
          unsubscribedAt: null,
          source: 'account',
          locale: customer.locale,
        },
      });
  } else {
    await tx
      .update(newsletterSubscribers)
      .set({ unsubscribedAt: sql`now()` })
      .where(eq(newsletterSubscribers.email, customer.email));
  }
  await writeAudit(tx, {
    userId: who.userId,
    action: input.subscribe ? 'customer.newsletter_subscribed' : 'customer.newsletter_unsubscribed',
    entity: 'customer',
    entityId: who.customerId,
    diff: { source: 'account' },
    ip: who.ip,
  });
  return true;
}

export interface SizeOption {
  id: string;
  label: string;
}

/** The sizes a customer may save: every bra size and every apparel size, in catalogue order. */
export async function listSaveableSizes(
  reader: Reader,
): Promise<{ bra: SizeOption[]; apparel: SizeOption[] }> {
  const rows = await reader
    .select({ id: sizes.id, label: sizes.label, system: sizes.system })
    .from(sizes)
    .where(sql`${sizes.system} IN ('bra', 'apparel')`)
    .orderBy(sizes.sortOrder, sizes.label);
  return {
    bra: rows.filter((row) => row.system === 'bra').map(({ id, label }) => ({ id, label })),
    apparel: rows.filter((row) => row.system === 'apparel').map(({ id, label }) => ({ id, label })),
  };
}

/** The labels of the saved sizes (for the browser's "your size" hint), or nulls. */
export async function mySizeLabels(
  reader: Reader,
  customerId: string,
): Promise<{ bra: string | null; apparel: string | null }> {
  const [row] = await reader
    .execute<{ bra: string | null; apparel: string | null }>(
      sql`SELECT b.label AS bra, a.label AS apparel
          FROM customers c
          LEFT JOIN sizes b ON b.id = c.preferred_bra_size_id
          LEFT JOIN sizes a ON a.id = c.preferred_apparel_size_id
         WHERE c.id = ${customerId}`,
    )
    .then((result) => result.rows);
  return { bra: row?.bra ?? null, apparel: row?.apparel ?? null };
}
