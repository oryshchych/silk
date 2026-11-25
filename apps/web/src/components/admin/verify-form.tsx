'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { verifyAction, type AuthFormState } from '@/actions/admin-auth';

import { buttonClass, fieldClass } from './auth-card';
import { formValues } from './form-values';

export function VerifyForm() {
  const t = useTranslations('admin.verify');
  const [recovery, setRecovery] = useState(false);
  const [state, setState] = useState<AuthFormState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const { code = '' } = formValues(event.currentTarget, ['code']);
        const mode = recovery ? 'recovery' : 'totp';
        startTransition(async () => {
          setState(await verifyAction({ code, mode }));
        });
      }}
      className="space-y-4"
    >
      <p className="text-text-muted">{t('hint')}</p>
      <label className="block">
        {recovery ? t('recoveryLabel') : t('code')}
        <input
          name="code"
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          required
          className={fieldClass}
        />
      </label>
      <p role="alert" aria-live="polite" className="min-h-6 text-danger">
        {state.status === 'error'
          ? t(state.code === 'rateLimited' ? 'rateLimited' : 'invalid')
          : ''}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={pending} className={buttonClass}>
          {t('submit')}
        </button>
        <button
          type="button"
          onClick={() => {
            setRecovery((value) => !value);
          }}
          className="min-h-11 min-w-11 underline"
        >
          {recovery ? t('useApp') : t('useRecovery')}
        </button>
      </div>
    </form>
  );
}
