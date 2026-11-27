/**
 * Who may do what (AGENTS.md section 2.6). The single source: every admin server action names
 * ONE permission from this map and `requirePermission` checks it inside the action; `proxy.ts`
 * is a convenience only. `docs/SECURITY.md` carries the same table, and a test fails when the
 * two drift apart.
 *
 * Roles: owner (everything), admin (everything except users and roles), manager (orders, stock,
 * customers), content (catalog text and media; may read prices, never write them or see the cost).
 */
export const ROLES = ['owner', 'admin', 'manager', 'content'] as const;
export type AdminRole = (typeof ROLES)[number];

/** Roles that must hold a confirmed TOTP before a session counts. */
export const MFA_REQUIRED_ROLES: readonly AdminRole[] = ['owner', 'admin'];

export const PERMISSIONS = {
  'admin.view': ['owner', 'admin', 'manager', 'content'],
  'users.manage': ['owner'],
  'catalog.create': ['owner', 'admin'],
  'catalog.edit': ['owner', 'admin', 'content'],
  'categories.edit': ['owner', 'admin', 'content'],
  'dictionaries.edit': ['owner', 'admin'],
  'catalog.price': ['owner', 'admin'],
  'catalog.cost.view': ['owner', 'admin'],
  'catalog.publish': ['owner', 'admin', 'content'],
  'stock.adjust': ['owner', 'admin', 'manager'],
  'orders.view': ['owner', 'admin', 'manager'],
  'orders.manage': ['owner', 'admin', 'manager'],
  'orders.cancel': ['owner', 'admin', 'manager'],
  'orders.edit': ['owner', 'admin', 'manager'],
  'orders.refund': ['owner', 'admin'],
  'orders.waybill': ['owner', 'admin', 'manager'],
  'orders.export': ['owner', 'admin'],
  'customers.view': ['owner', 'admin', 'manager'],
  'customers.manage': ['owner', 'admin', 'manager'],
  'customers.export': ['owner', 'admin'],
  'returns.manage': ['owner', 'admin', 'manager'],
  'reviews.moderate': ['owner', 'admin', 'content'],
  'orders.confirm_payment': ['owner', 'admin', 'manager'],
  'legal.edit': ['owner', 'admin', 'content'],
  'legal.publish': ['owner', 'admin'],
  'media.upload': ['owner', 'admin', 'content'],
  'catalog.import': ['owner', 'admin'],
  'catalog.export': ['owner', 'admin'],
  'reports.view': ['owner', 'admin', 'manager'],
  'reports.export': ['owner', 'admin'],
  'promo.view': ['owner', 'admin', 'manager'],
  'promo.manage': ['owner', 'admin'],
  'banners.edit': ['owner', 'admin', 'content'],
} as const satisfies Record<string, readonly AdminRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: AdminRole, permission: Permission): boolean {
  const allowed: readonly AdminRole[] = PERMISSIONS[permission];
  return allowed.includes(role);
}
