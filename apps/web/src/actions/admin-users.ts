'use server';

import {
  changeUserRole,
  createUser,
  resetUserPassword,
  setUserActive,
  userSchemas,
} from '@store/core/users-admin';

import { adminAction } from '@/lib/admin/bound-action';

/**
 * The owner's user management (`users.manage`: owner only, checked by `adminAction` before the
 * input is parsed). One audit row per change with the author and address. A password is never
 * copied into an audit row (only that it was set), never returned and never logged; the audit
 * redaction would also hide a key named `password`.
 */
export async function createUserAction(input: unknown) {
  return await adminAction({
    permission: 'users.manage',
    schema: userSchemas.create,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      const created = await createUser(tx, { ...parsed, actorId: session.userId });
      await audit({
        action: 'create',
        entity: 'admin_user',
        entityId: created.userId,
        diff: { role: parsed.role },
      });
      return { userId: created.userId };
    },
  });
}

export async function changeUserRoleAction(input: unknown) {
  return await adminAction({
    permission: 'users.manage',
    schema: userSchemas.role,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await changeUserRole(tx, { ...parsed, actorId: session.userId });
      if (!done.changed) {
        skipAudit();
        return { changed: false };
      }
      await audit({
        action: 'update',
        entity: 'admin_user',
        entityId: parsed.userId,
        diff: { role: { from: done.from, to: done.to }, sessionsEnded: true },
      });
      return { changed: true };
    },
  });
}

export async function setUserActiveAction(input: unknown) {
  return await adminAction({
    permission: 'users.manage',
    schema: userSchemas.active,
    input,
    run: async ({ tx, input: parsed, session, audit, skipAudit }) => {
      const done = await setUserActive(tx, { ...parsed, actorId: session.userId });
      if (!done.changed) {
        skipAudit();
        return { changed: false };
      }
      await audit({
        action: 'update',
        entity: 'admin_user',
        entityId: parsed.userId,
        diff: { active: parsed.active, sessionsEnded: !parsed.active },
      });
      return { changed: true };
    },
  });
}

export async function resetUserPasswordAction(input: unknown) {
  return await adminAction({
    permission: 'users.manage',
    schema: userSchemas.password,
    input,
    run: async ({ tx, input: parsed, session, audit }) => {
      await resetUserPassword(tx, { ...parsed, actorId: session.userId });
      await audit({
        action: 'update',
        entity: 'admin_user',
        entityId: parsed.userId,
        diff: { passwordReset: true, sessionsEnded: true },
      });
      return { changed: true };
    },
  });
}
