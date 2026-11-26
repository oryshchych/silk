'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { createUserAction } from '@/actions/admin-users';

import { StatusLine } from './fields';
import { readForm, textOf, useAdminAction } from './use-admin-action';

const field = 'mt-1 block min-h-11 w-full rounded-md border border-border bg-surface px-3';

export interface RoleOption {
  value: string;
  text: string;
}

/** A new admin account: email, role, and a first password the person changes... by asking the owner (no self-service yet). */
export function UserCreateForm({ roles }: { roles: RoleOption[] }) {
  const t = useTranslations('admin.users');
  const router = useRouter();
  const { message, pending, run, setMessage } = useAdminAction();
  return (
    <form
      className="mt-4 grid max-w-xl gap-3"
      aria-labelledby="new-user"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = readForm(form);
        setMessage(null);
        run(
          async () =>
            await createUserAction({
              email: textOf(data, 'email'),
              role: textOf(data, 'role'),
              password: textOf(data, 'password'),
            }),
          t('created'),
          () => {
            form.reset();
            router.refresh();
          },
        );
      }}
    >
      <h2 id="new-user" className="text-lg font-semibold">
        {t('newUser')}
      </h2>
      <label className="block">
        {t('col.email')}
        <input
          name="email"
          type="email"
          required
          maxLength={320}
          autoComplete="off"
          className={field}
        />
      </label>
      <label className="block">
        {t('col.role')}
        <select name="role" defaultValue="manager" className={field}>
          {roles.map((role) => (
            <option key={role.value} value={role.value}>
              {role.text}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        {t('password')}
        <input
          name="password"
          type="password"
          required
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          className={field}
        />
        <span className="mt-1 block text-sm text-text-muted">{t('passwordHint')}</span>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 min-w-11 rounded-md bg-accent px-4 font-medium text-accent-contrast disabled:opacity-60"
      >
        {t('create')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
