import { can, type AdminRole, type Permission } from '@store/core/auth-permissions';

/**
 * Which admin message namespaces reach the BROWSER, and for whom. A namespace not listed here is never
 * sent (fail closed), so a new section of the admin must add its namespace here with the permission
 * that opens it; a test fails when a namespace of `en.json` is missing from this map.
 *
 * - `public`: the login flow (anonymous and half-signed-in visitors get only these);
 * - a permission: sent to a full session whose role holds it;
 * - `server`: rendered on the server only, never sent.
 */
export const NAMESPACE_ACCESS = {
  meta: 'public',
  login: 'public',
  verify: 'public',
  enroll: 'public',
  shell: 'public',
  errors: 'admin.view',
  dashboard: 'admin.view',
  state: 'admin.view',
  products: 'admin.view',
  editor: 'admin.view',
  taxonomy: 'admin.view',
  media: 'admin.view',
  stock: 'admin.view',
  contentReadiness: 'admin.view',
  categoryEditor: 'admin.view',
  importExport: 'catalog.import',
  orders: 'orders.view',
  customers: 'customers.view',
  users: 'users.manage',
  reviews: 'reviews.moderate',
  returns: 'returns.manage',
  legal: 'legal.edit',
  promo: 'promo.view',
  marketing: 'promo.view',
  banners: 'banners.edit',
  reports: 'server',
  dashboardReports: 'server',
} as const satisfies Record<string, Permission | 'public' | 'server'>;

/** The namespaces of `admin` this visitor may receive; `role` is null unless the session is a full one. */
export function clientAdminMessages(
  admin: Record<string, unknown>,
  role: AdminRole | null,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(admin).filter(([name]) => {
      const rule = Object.entries(NAMESPACE_ACCESS).find(([key]) => key === name)?.[1];
      if (rule === undefined || rule === 'server') return false;
      if (rule === 'public') return true;
      return role !== null && can(role, rule);
    }),
  );
}
