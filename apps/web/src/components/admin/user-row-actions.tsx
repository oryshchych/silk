'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import {
  changeUserRoleAction,
  resetUserPasswordAction,
  setUserActiveAction,
} from '@/actions/admin-users';

import { StatusLine } from './fields';
import type { RoleOption } from './user-create-form';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const field = 'min-h-11 rounded-md border border-border bg-surface px-2';
const button = 'min-h-11 min-w-11 rounded-md border border-border px-3 disabled:opacity-60';

/** Role, status and password of ANOTHER account (the screen shows no controls for your own). */
export function UserRowActions(props: {
  userId: string;
  email: string;
  role: string;
  isActive: boolean;
  roles: RoleOption[];
}) {
  const t = useTranslations('admin.users');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  const refresh = () => {
    router.refresh();
  };
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const data = readForm(event.currentTarget);
          setMessage(null);
          run(
            async () =>
              await changeUserRoleAction({ userId: props.userId, role: textOf(data, 'role') }),
            t('saved'),
            refresh,
          );
        }}
      >
        <label className="block">
          <span className="sr-only">
            {t('col.role')} {props.email}
          </span>
          <select name="role" defaultValue={props.role} className={field}>
            {props.roles.map((role) => (
              <option key={role.value} value={role.value}>
                {role.text}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={button}>
          {t('changeRole')}
        </button>
        <button
          type="button"
          disabled={pending}
          className={button}
          onClick={() => {
            setMessage(null);
            run(
              async () =>
                await setUserActiveAction({ userId: props.userId, active: !props.isActive }),
              t('saved'),
              refresh,
            );
          }}
        >
          {props.isActive ? t('deactivate') : t('activate')}
        </button>
      </form>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = readForm(form);
          setMessage(null);
          run(
            async () =>
              await resetUserPasswordAction({
                userId: props.userId,
                password: textOf(data, 'password'),
              }),
            t('passwordReset'),
            () => {
              form.reset();
              refresh();
            },
          );
        }}
      >
        <label className="block">
          <span className="sr-only">
            {t('newPassword')} {props.email}
          </span>
          <input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            placeholder={t('newPassword')}
            className={`${field} w-48`}
          />
        </label>
        <button type="submit" disabled={pending} className={button}>
          {t('resetPassword')}
        </button>
      </form>
      <StatusLine message={message} />
    </div>
  );
}
