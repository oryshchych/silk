'use server';

import { revokeOtherSessions } from '@store/core/auth';
import { z } from 'zod';

import { adminAction } from '@/lib/admin/bound-action';

export type SignOutOthersResult = { ok: true; ended: number } | { ok: false; code: string };

/**
 * "Sign out of all other devices": every role may do it, to its own account only (the user id is
 * the session's, never an argument). It goes through `adminAction`, so the Origin, the session,
 * the permission, the limit and the audit row are the same as for every other admin mutation.
 */
export async function signOutOtherSessionsAction(): Promise<SignOutOthersResult> {
  const result = await adminAction({
    permission: 'admin.view',
    schema: z.object({}),
    input: {},
    run: async ({ tx, session, audit }) => {
      const ended = await revokeOtherSessions(tx, {
        userId: session.userId,
        keepSid: session.sid,
      });
      await audit({
        action: 'update',
        entity: 'auth_session',
        entityId: session.userId,
        diff: { revokedOtherSessions: ended },
      });
      return ended;
    },
  });
  return result.ok ? { ok: true, ended: result.data } : { ok: false, code: result.code };
}
