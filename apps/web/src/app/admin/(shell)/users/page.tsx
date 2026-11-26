import { listAdminUsers } from '@store/core/users-admin';
import { ROLES } from '@store/core/auth-permissions';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { UserCreateForm } from '@/components/admin/user-create-form';
import { UserRowActions } from '@/components/admin/user-row-actions';
import { formatWhen } from '@/lib/admin/format';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePermission } from '@/lib/admin/session';
import { getDb } from '@/lib/db';

export default async function AdminUsersPage() {
  const session = await requirePermission('users.manage');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.users' });
  const users = await listAdminUsers(await getDb());
  const header = 'px-3 py-2 text-left font-medium';
  const cell = 'px-3 py-2 align-top';
  const roleOptions = ROLES.map((role) => ({ value: role, text: t(`role.${role}`) }));
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-1 text-text-muted">{t('intro')}</p>
      <UserCreateForm roles={roleOptions} />
      <div className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">{t('title')}</caption>
          <thead>
            <tr className="border-b border-border">
              {[
                t('col.email'),
                t('col.role'),
                t('col.status'),
                t('col.mfa'),
                t('col.lastLogin'),
                t('col.sessions'),
                t('col.actions'),
              ].map((label) => (
                <th key={label} scope="col" className={header}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.userId} className="border-b border-border">
                <td className={cell}>{user.email}</td>
                <td className={cell}>{t(`role.${user.role}`)}</td>
                <td className={cell}>{user.isActive ? t('active') : t('inactive')}</td>
                <td className={cell}>{user.mfaConfirmed ? t('yes') : t('no')}</td>
                <td className={cell}>
                  {user.lastLoginAt === null ? '—' : formatWhen(user.lastLoginAt, locale)}
                </td>
                <td className={cell}>{user.liveSessions}</td>
                <td className={cell}>
                  {user.userId === session.userId ? (
                    <span className="text-text-muted">{t('you')}</span>
                  ) : (
                    <UserRowActions
                      userId={user.userId}
                      email={user.email}
                      role={user.role}
                      isActive={user.isActive}
                      roles={roleOptions}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
