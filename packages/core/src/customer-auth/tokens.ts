/**
 * E-mail links of the customer account (address verification, password reset).
 *
 * The token is `<row id>.<HMAC(id)>` under a key derived (HKDF) from `AUTH_SECRET`. Nothing that
 * works as a credential is stored or queued: the table holds the id, the purpose and the expiry,
 * and the worker rebuilds the token from the id when it writes the mail. A token is good once
 * (`used_at`), for a short time (database clock), and a newer one for the same purpose replaces
 * the older ones. A burst of requests for one account is capped, so the form cannot be used to
 * flood someone's inbox.
 */
import { createHmac } from 'node:crypto';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { authEmailTokens } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { constantTimeEqual, deriveKey } from '../auth/crypto.ts';

export type EmailTokenPurpose = 'verify_email' | 'reset_password';

export const TOKEN_MINUTES: Record<EmailTokenPurpose, number> = {
  verify_email: 24 * 60,
  reset_password: 60,
};
/** Mails of one purpose for one account per hour; past it the request is silently not sent. */
export const MAX_TOKENS_PER_HOUR = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const signature = (secret: string | undefined, id: string): string =>
  createHmac('sha256', deriveKey(secret, 'email-token')).update(`v1:${id}`).digest('base64url');

/** The token for a row id. The worker calls this; it throws (fails closed) without a strong secret. */
export function buildEmailToken(secret: string | undefined, id: string): string {
  return `${id}.${signature(secret, id)}`;
}

/** The row id a token names, or null when the shape or the signature is wrong. */
export function readEmailToken(secret: string | undefined, token: string): { id: string } | null {
  if (token.length > 200) return null;
  const [id, given, ...rest] = token.split('.');
  if (rest.length > 0 || id === undefined || given === undefined || !UUID.test(id)) return null;
  return constantTimeEqual(given, signature(secret, id)) ? { id } : null;
}

/**
 * A new token row for the account, or null when the account asked too often. The caller holds
 * the account lock (`lockAccount`), so two parallel requests cannot both pass the cap.
 */
export async function issueEmailToken(
  tx: Tx,
  input: { userId: string; purpose: EmailTokenPurpose; locale: 'uk' | 'en' },
): Promise<string | null> {
  const [recent] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(authEmailTokens)
    .where(
      and(
        eq(authEmailTokens.userId, input.userId),
        eq(authEmailTokens.purpose, input.purpose),
        gt(authEmailTokens.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((recent?.count ?? 0) >= MAX_TOKENS_PER_HOUR) return null;
  await tx
    .update(authEmailTokens)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(authEmailTokens.userId, input.userId),
        eq(authEmailTokens.purpose, input.purpose),
        isNull(authEmailTokens.usedAt),
      ),
    );
  const [row] = await tx
    .insert(authEmailTokens)
    .values({
      userId: input.userId,
      purpose: input.purpose,
      locale: input.locale,
      expiresAt: sql`now() + make_interval(mins => ${TOKEN_MINUTES[input.purpose]})`,
    })
    .returning({ id: authEmailTokens.id });
  if (row === undefined) throw new Error('token insert returned no row');
  return row.id;
}
