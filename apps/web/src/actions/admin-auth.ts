'use server';

import {
  beginLogin,
  confirmTotpEnrolment,
  logout,
  startTotpEnrolment,
  verifyRecoveryLogin,
  verifyTotpLogin,
  type ClientInfo,
} from '@store/core/auth';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { authConfig, cookiesAreSecure } from '@/lib/admin/config';
import { requestOriginOk } from '@/lib/admin/bound-action';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/admin/cookies';
import { currentSession } from '@/lib/admin/session';
import { getDb } from '@/lib/db';
import { createRateLimiter } from '@/lib/rate-limit';
import { checkLimit, currentClient } from '@/lib/request-limits';

/**
 * Credential actions of the admin login. None of them needs a role (nobody has a session yet);
 * what protects them is the Origin check, the per-client limit (here AND in `proxy.ts`), the
 * account lockout in `@store/core/auth`, and a refusal that never says why.
 */
export type AuthFormState =
  { status: 'idle' } | { status: 'error'; code: 'invalid' | 'rateLimited' | 'error' };

export type EnrolStartState =
  | { status: 'idle' }
  | { status: 'ready'; secret: string; uri: string }
  | { status: 'error'; code: 'error' | 'rateLimited' };

export type EnrolConfirmState =
  | { status: 'idle' }
  | { status: 'error'; code: 'invalid' | 'rateLimited' | 'error' }
  | { status: 'done'; recoveryCodes: string[] };

const loginLimiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
const stepLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });

const loginSchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(256),
});
const codeSchema = z.object({ code: z.string().trim().min(6).max(24) });
const verifySchema = codeSchema.extend({ mode: z.enum(['totp', 'recovery']) });

async function clientInfo(): Promise<ClientInfo> {
  const list = await headers();
  const ip = await currentClient();
  return { ip: ip === 'unknown' ? null : ip, userAgent: list.get('user-agent') };
}

async function setSession(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(
    SESSION_COOKIE,
    token,
    sessionCookieOptions(expiresAt, await cookiesAreSecure()),
  );
}

async function pendingToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

type Gate = { ok: true } | { ok: false; code: 'error' | 'rateLimited' };

/** Origin and per-client limit, before anything touches the database. */
async function gate(limiter: ReturnType<typeof createRateLimiter>): Promise<Gate> {
  if (!(await requestOriginOk())) return { ok: false, code: 'error' };
  if (!(await checkLimit(limiter)).allowed) return { ok: false, code: 'rateLimited' };
  return { ok: true };
}

/** Plain arguments, not FormData: the forms call these from a transition (see the components). */
export async function loginAction(input: unknown): Promise<AuthFormState> {
  const allowed = await gate(loginLimiter);
  if (!allowed.ok) return { status: 'error', code: allowed.code };
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'invalid' };
  const config = await authConfig();
  const db = await getDb();
  const client = await clientInfo();
  const result = await db.transaction(
    async (tx) => await beginLogin(tx, config, { ...parsed.data, client }),
  );
  if (!result.ok) return { status: 'error', code: 'invalid' };
  await setSession(result.token, result.expiresAt);
  redirect(
    result.next === 'done' ? '/admin' : result.next === 'totp' ? '/admin/verify' : '/admin/enroll',
  );
}

export async function verifyAction(input: unknown): Promise<AuthFormState> {
  const allowed = await gate(stepLimiter);
  if (!allowed.ok) return { status: 'error', code: allowed.code };
  const token = await pendingToken();
  const parsed = verifySchema.safeParse(input);
  if (token === null || !parsed.success) return { status: 'error', code: 'invalid' };
  const config = await authConfig();
  const client = await clientInfo();
  const recovery = parsed.data.mode === 'recovery';
  const result = await (
    await getDb()
  ).transaction(async (tx) =>
    recovery
      ? await verifyRecoveryLogin(tx, config, { token, code: parsed.data.code, client })
      : await verifyTotpLogin(tx, config, { token, code: parsed.data.code, client }),
  );
  if (!result.ok) return { status: 'error', code: 'invalid' };
  await setSession(result.token, result.expiresAt);
  redirect('/admin');
}

export async function startEnrolAction(): Promise<EnrolStartState> {
  const allowed = await gate(stepLimiter);
  if (!allowed.ok) return { status: 'error', code: allowed.code };
  const token = await pendingToken();
  if (token === null) return { status: 'error', code: 'error' };
  const started = await (
    await getDb()
  ).transaction(async (tx) => await startTotpEnrolment(tx, await authConfig(), { token }));
  return started === null
    ? { status: 'error', code: 'error' }
    : { status: 'ready', secret: started.secret, uri: started.uri };
}

export async function confirmEnrolAction(input: unknown): Promise<EnrolConfirmState> {
  const allowed = await gate(stepLimiter);
  if (!allowed.ok) return { status: 'error', code: allowed.code };
  const token = await pendingToken();
  const parsed = codeSchema.safeParse(input);
  if (token === null || !parsed.success) return { status: 'error', code: 'invalid' };
  const config = await authConfig();
  const client = await clientInfo();
  const result = await (
    await getDb()
  ).transaction(
    async (tx) => await confirmTotpEnrolment(tx, config, { token, code: parsed.data.code, client }),
  );
  if (!result.ok) return { status: 'error', code: 'invalid' };
  await setSession(result.token, result.expiresAt);
  return { status: 'done', recoveryCodes: result.recoveryCodes ?? [] };
}

export async function logoutAction(): Promise<void> {
  if (await requestOriginOk()) {
    const resolved = await currentSession();
    if (resolved !== null) {
      const db = await getDb();
      await db.transaction(async (tx) => {
        await logout(tx, { sid: resolved.session.sid, userId: resolved.session.userId });
      });
    }
  }
  (await cookies()).delete({ name: SESSION_COOKIE, path: '/admin' });
  redirect('/admin/login');
}
