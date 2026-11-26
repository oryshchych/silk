/**
 * Customer sessions. Same design as the admin (ADR-19): a signed token names a row of
 * `auth_sessions`, and everything that decides whether it counts is read from the database on
 * every request. Two differences keep the audiences apart: the row has `audience = 'customer'`
 * (an admin lookup filters on `'admin'`), and the token is signed under its own derived key, so a
 * token of one audience is not even a valid signature for the other.
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { authSessions, authUsers, customers } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';

import { deriveKey } from '../auth/crypto.ts';
import { readSessionToken, signSessionToken } from '../auth/session-token.ts';
import type { AuthConfig, ClientInfo } from '../auth/service.ts';
import { writeAudit } from '../audit/write-audit.ts';

export const CUSTOMER_SESSION_DAYS = 14;

export interface CustomerSession {
  sid: string;
  userId: string;
  customerId: string;
  email: string;
  locale: 'uk' | 'en';
}

const key = (config: AuthConfig): Buffer => deriveKey(config.secret, 'customer-session');
const nowOf = (config: AuthConfig): number => (config.nowMs ?? Date.now)();

export async function openCustomerSession(
  tx: Tx,
  config: AuthConfig,
  input: { userId: string; client: ClientInfo },
): Promise<{ token: string; expiresAt: Date }> {
  const [row] = await tx
    .insert(authSessions)
    .values({
      userId: input.userId,
      audience: 'customer',
      expiresAt: sql`now() + make_interval(days => ${CUSTOMER_SESSION_DAYS})`,
      ip: input.client.ip?.slice(0, 45) ?? null,
      userAgent: input.client.userAgent?.slice(0, 300) ?? null,
    })
    .returning({ sid: authSessions.sid, expiresAt: authSessions.expiresAt });
  if (row === undefined) throw new Error('session insert returned no row');
  return {
    token: signSessionToken(row.sid, row.expiresAt.getTime(), key(config)),
    expiresAt: row.expiresAt,
  };
}

/** The session a token names, or null. The account, its verified address and the revocation are read live. */
export async function resolveCustomerSession(
  db: Reader,
  config: AuthConfig,
  token: string | null | undefined,
): Promise<CustomerSession | null> {
  if (token === null || token === undefined || token === '') return null;
  const parsed = readSessionToken(token, key(config), nowOf(config));
  if (parsed === null) return null;
  const [row] = await db
    .select({
      sid: authSessions.sid,
      userId: authSessions.userId,
      customerId: customers.id,
      email: customers.email,
      locale: customers.locale,
    })
    .from(authSessions)
    .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
    .innerJoin(customers, eq(customers.userId, authSessions.userId))
    .where(
      and(
        eq(authSessions.sid, parsed.sid),
        eq(authSessions.audience, 'customer'),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, sql`now()`),
        sql`${authUsers.emailVerifiedAt} IS NOT NULL`,
      ),
    );
  if (row === undefined) return null;
  return { ...row, locale: row.locale === 'en' ? 'en' : 'uk' };
}

export async function logoutCustomer(
  tx: Tx,
  input: { sid: string; userId: string },
): Promise<void> {
  await tx
    .update(authSessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(authSessions.sid, input.sid),
        eq(authSessions.audience, 'customer'),
        isNull(authSessions.revokedAt),
      ),
    );
  await writeAudit(tx, {
    userId: input.userId,
    action: 'customer.logout',
    entity: 'auth_session',
    entityId: input.sid,
  });
}

/** After a password reset: every customer session of the account stops counting. */
export async function revokeCustomerSessions(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(authSessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(authSessions.userId, userId),
        eq(authSessions.audience, 'customer'),
        isNull(authSessions.revokedAt),
      ),
    );
}
