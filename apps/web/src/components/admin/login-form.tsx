'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { loginAction, type AuthFormState } from '@/actions/admin-auth';

import { buttonClass, fieldClass } from './auth-card';
import { formValues } from './form-values';

export function LoginForm() {
  const t = useTranslations('admin.login');
  const [state, setState] = useState<AuthFormState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const values = formValues(event.currentTarget, ['email', 'password']);
        startTransition(async () => {
          // On success the action redirects; only a refusal comes back.
          setState(await loginAction(values));
        });
      }}
      className="space-y-4"
    >
      <label className="block">
        {t('email')}
        <input name="email" type="email" autoComplete="username" required className={fieldClass} />
      </label>
      <label className="block">
        {t('password')}
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={fieldClass}
        />
      </label>
      <p role="alert" aria-live="polite" className="min-h-6 text-danger">
        {state.status === 'error' ? t(state.code) : ''}
      </p>
      <button type="submit" disabled={pending} className={buttonClass}>
        {t('submit')}
      </button>
    </form>
  );
}
