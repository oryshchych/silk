/**
 * The ONE way an admin mutation runs (AGENTS.md section 2.6). Every step happens inside the
 * action, in this order, and `proxy.ts` plays no part in any of them:
 *
 *   origin (CSRF) -> full session read from the database -> the ONE permission the action names
 *   -> per-user rate limit -> zod validation -> a transaction that must write `audit_log`.
 *
 * A role without the permission is refused BEFORE the input is even parsed and before the handler
 * is reached. A handler that finishes without writing an audit row is rolled back and reported:
 * "every mutation is audited" is enforced here, not left to remembering.
 */
import { DomainError } from '@store/core/errors';
import { writeAudit, type AuditEntry } from '@store/core/audit';
import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { can, type Permission } from '@store/core/auth-permissions';
import type { Tx } from '@store/db/types';
import type { z } from 'zod';

import type { RateLimiter } from '../rate-limit';

type AdminActionFailure =
  | { ok: false; code: 'BAD_ORIGIN' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' }
  | { ok: false; code: 'RATE_LIMITED'; retryAfterSeconds: number }
  | { ok: false; code: string };

export type AdminActionResult<R> = { ok: true; data: R } | AdminActionFailure;

export interface AdminActionDeps {
  originOk: () => Promise<boolean>;
  session: () => Promise<ResolvedSession | null>;
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  client: () => Promise<string | null>;
  limiter: RateLimiter;
}

interface AdminActionContext<Input> {
  tx: Tx;
  session: AdminSession;
  input: Input;
  /** Writes the audit row: the author and the client address are filled in, never taken from input. */
  audit: (entry: Omit<AuditEntry, 'userId' | 'ip'>) => Promise<void>;
}

export interface AdminActionSpec<S extends z.ZodType, R> {
  permission: Permission;
  schema: S;
  input: unknown;
  run: (context: AdminActionContext<z.infer<S>>) => Promise<R>;
}

export class MissingAuditError extends Error {
  constructor(permission: Permission) {
    super(`admin action for "${permission}" finished without writing an audit row`);
    this.name = 'MissingAuditError';
  }
}

export function createAdminAction(deps: AdminActionDeps) {
  return async function adminAction<S extends z.ZodType, R>(
    spec: AdminActionSpec<S, R>,
  ): Promise<AdminActionResult<R>> {
    if (!(await deps.originOk())) return { ok: false, code: 'BAD_ORIGIN' };
    const resolved = await deps.session();
    if (resolved?.kind !== 'full') return { ok: false, code: 'UNAUTHENTICATED' };
    const { session } = resolved;
    if (!can(session.role, spec.permission)) return { ok: false, code: 'FORBIDDEN' };
    const verdict = deps.limiter.check(session.userId);
    if (!verdict.allowed) {
      return { ok: false, code: 'RATE_LIMITED', retryAfterSeconds: verdict.retryAfterSeconds };
    }
    const parsed = spec.schema.safeParse(spec.input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    const ip = await deps.client();
    try {
      const data = await deps.transaction(async (tx) => {
        const state = { audited: false };
        const result = await spec.run({
          tx,
          session,
          input: parsed.data,
          audit: async (entry) => {
            await writeAudit(tx, { ...entry, userId: session.userId, ip });
            state.audited = true;
          },
        });
        if (!state.audited) throw new MissingAuditError(spec.permission);
        return result;
      });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, code: error.code };
      throw error;
    }
  };
}
