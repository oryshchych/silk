/**
 * Who may do what (AGENTS.md section 2.6). The single source: every admin server action names
 * ONE permission from this map and `requirePermission` checks it inside the action; `proxy.ts`
 * is a convenience only. `docs/SECURITY.md` carries the same table, and a test fails when the
 * two drift apart.
 *
 * Roles: owner (everything), admin (everything except users and roles), manager (orders, stock,
 * customers), content (catalog text and media, never prices or money).
 */
export const ROLES = ['owner', 'admin', 'manager', 'content'] as const;
export type AdminRole = (typeof ROLES)[number];

/** Roles that must hold a confirmed TOTP before a session counts. */
export const MFA_REQUIRED_ROLES: readonly AdminRole[] = ['owner', 'admin'];

export const PERMISSIONS = {
  'admin.view': ['owner', 'admin', 'manager', 'content'],
  'users.manage': ['owner'],
  'catalog.edit': ['owner', 'admin', 'content'],
  'catalog.price': ['owner', 'admin'],
  'catalog.cost.view': ['owner', 'admin'],
  'catalog.publish': ['owner', 'admin', 'content'],
  'stock.adjust': ['owner', 'admin', 'manager'],
  'media.upload': ['owner', 'admin', 'content'],
  'catalog.import': ['owner', 'admin'],
  'catalog.export': ['owner', 'admin'],
} as const satisfies Record<string, readonly AdminRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: AdminRole, permission: Permission): boolean {
  const allowed: readonly AdminRole[] = PERMISSIONS[permission];
  return allowed.includes(role);
}
