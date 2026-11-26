import { resolveSession, type AdminSession, type ResolvedSession } from '@store/core/auth';
import { can, type Permission } from '@store/core/auth-permissions';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { getDb } from '../db';
import { authConfig } from './config';
import { SESSION_COOKIE } from './cookies';

/** `Authorization: Bearer <token>`: the same token a mobile client holds (ADR-12, ADR-19). */
export function tokenFromAuthorization(header: string | null): string | null {
  const match = /^Bearer ([A-Za-z0-9._-]{1,200})$/.exec(header ?? '');
  return match?.[1] ?? null;
}

/** The session of this request: cookie first, then a bearer header. Read from the database, never trusted from the token. */
export async function currentSession(): Promise<ResolvedSession | null> {
  const token =
    (await cookies()).get(SESSION_COOKIE)?.value ??
    tokenFromAuthorization((await headers()).get('authorization'));
  if (token === null) return null;
  return await resolveSession(await getDb(), await authConfig(), token);
}

/** A page of the admin: a full session or a redirect to the right login step. */
export async function requireFullSession(): Promise<AdminSession> {
  const resolved = await currentSession();
  if (resolved?.kind === 'full') return resolved.session;
  if (resolved?.kind === 'pending') {
    redirect(resolved.next === 'totp' ? '/admin/verify' : '/admin/enroll');
  }
  redirect('/admin/login');
}

/** A step page of the login flow: the pending session must be at THIS step. */
export async function requirePendingStep(step: 'totp' | 'enroll'): Promise<AdminSession> {
  const resolved = await currentSession();
  if (resolved?.kind === 'full') redirect('/admin');
  if (resolved?.kind !== 'pending') redirect('/admin/login');
  if (resolved.next !== step)
    redirect(resolved.next === 'totp' ? '/admin/verify' : '/admin/enroll');
  return resolved.session;
}

/**
 * A page of the admin that needs one permission: the full session, then the permission. A role
 * without it gets the same 404 as an address that does not exist (nothing says the page is there).
 */
export async function requirePermission(permission: Permission): Promise<AdminSession> {
  const session = await requireFullSession();
  if (!can(session.role, permission)) notFound();
  return session;
}
