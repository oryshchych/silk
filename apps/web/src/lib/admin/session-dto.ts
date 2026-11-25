import type { AdminSession } from '@store/core/auth';
import { PERMISSIONS, can, type AdminRole, type Permission } from '@store/core/auth-permissions';

/**
 * What the browser may know about the signed-in user: an explicit list of fields, never the
 * session row (no `sid`, no user id). `permissions` lets the UI hide what the role cannot do; the
 * server still refuses it in the action.
 */
export interface AdminSessionDto {
  email: string;
  role: AdminRole;
  permissions: Permission[];
}

export function toAdminSessionDto(session: AdminSession): AdminSessionDto {
  const all = Object.keys(PERMISSIONS) as Permission[];
  return {
    email: session.email,
    role: session.role,
    permissions: all.filter((permission) => can(session.role, permission)),
  };
}
