'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import {
  customerLoginAction,
  forgotPasswordAction,
  registerAction,
  setPasswordAction,
  type AccountFormState,
} from '@/actions/account-auth';
import { fieldText } from '@/lib/form-text';

const FIELD = 'min-h-10 rounded-sm border border-border bg-surface px-3';
const BUTTON =
  'min-h-11 rounded-full bg-accent px-6 text-accent-contrast focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';

export type AccountFormKind = 'login' | 'register' | 'forgot' | 'setPassword';

const ERRORS = {
  invalid: 'error.invalid',
  weak: 'error.weak',
  rateLimited: 'error.rateLimited',
  error: 'error.error',
} as const;

const SUBMIT = {
  login: 'loginSubmit',
  register: 'registerSubmit',
  forgot: 'forgotSubmit',
  setPassword: 'setPasswordSubmit',
} as const;

/**
 * One form for the four credential steps of the account. The page decides which; the answer area is
 * a live region, so a screen reader hears "sent" or the refusal. A refusal never says whether an
 * address has an account.
 */
export function AccountForm({
  kind,
  locale,
  token,
}: {
  kind: AccountFormKind;
  locale: 'uk' | 'en';
  /** The mailed link's token (set-password only). It never leaves the POST body. */
  token?: string | undefined;
}) {
  const t = useTranslations('account');
  const emailId = useId();
  const passwordId = useId();
  const hintId = useId();
  const [pending, start] = useTransition();
  const [state, setState] = useState<AccountFormState>({ status: 'idle' });
  const withEmail = kind !== 'setPassword';
  const withPassword = kind === 'login' || kind === 'setPassword';

  function submit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    start(async () => {
      const email = fieldText(form, 'email');
      const password = fieldText(form, 'password');
      if (kind === 'login') setState(await customerLoginAction({ email, password, locale }));
      else if (kind === 'register') setState(await registerAction({ email, locale }));
      else if (kind === 'forgot') setState(await forgotPasswordAction({ email, locale }));
      else setState(await setPasswordAction({ token: token ?? '', password, locale }));
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-3" noValidate={false}>
      {withEmail ? (
        <label htmlFor={emailId} className="flex flex-col gap-1 text-sm">
          {t('email')}
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={320}
            className={FIELD}
          />
        </label>
      ) : null}
      {withPassword ? (
        <label htmlFor={passwordId} className="flex flex-col gap-1 text-sm">
          {kind === 'login' ? t('password') : t('newPassword')}
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete={kind === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={kind === 'login' ? 1 : 12}
            maxLength={128}
            aria-describedby={kind === 'setPassword' ? hintId : undefined}
            className={FIELD}
          />
        </label>
      ) : null}
      {kind === 'setPassword' ? (
        <p id={hintId} className="text-sm text-text-muted">
          {t('passwordHint')}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={BUTTON}>
        {t(SUBMIT[kind])}
      </button>
      <div aria-live="polite" className="min-h-6 text-sm">
        {state.status === 'sent' ? (
          <p role="status">{t(kind === 'forgot' ? 'forgotSent' : 'registerSent')}</p>
        ) : null}
        {state.status === 'error' ? (
          <p role="alert" className="text-danger">
            {t(ERRORS[state.code])}
          </p>
        ) : null}
      </div>
    </form>
  );
}
