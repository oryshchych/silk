'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  confirmEnrolAction,
  startEnrolAction,
  type EnrolConfirmState,
  type EnrolStartState,
} from '@/actions/admin-auth';

import { buttonClass, fieldClass } from './auth-card';
import { formValues } from './form-values';

/**
 * `signedIn`: the page was re-rendered after the confirm action set the session cookie. The form's
 * own state still holds the recovery codes (shown once); without that state there is nothing left
 * to do here but go on.
 */
export function EnrolForm({ signedIn }: { signedIn: boolean }) {
  const t = useTranslations('admin.enroll');
  const shell = useTranslations('admin.shell');
  const [start, setStart] = useState<EnrolStartState>({ status: 'idle' });
  const [starting, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<EnrolConfirmState>({ status: 'idle' });
  const [confirming, startConfirm] = useTransition();

  if (confirm.status === 'done') {
    return (
      <section aria-labelledby="recovery-title" className="space-y-4">
        <h2 id="recovery-title" className="text-lg font-semibold">
          {t('recoveryTitle')}
        </h2>
        <p className="text-text-muted">{t('recoveryHint')}</p>
        <ul className="grid grid-cols-2 gap-2 font-mono">
          {confirm.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        {/* A full navigation: the session cookie changed, the next page reads it fresh. */}
        <a href="/admin" className={`${buttonClass} inline-flex items-center`}>
          {t('continue')}
        </a>
      </section>
    );
  }

  if (signedIn) {
    return (
      <a href="/admin" className={`${buttonClass} inline-flex items-center`}>
        {shell('dashboard')}
      </a>
    );
  }

  if (start.status !== 'ready') {
    return (
      <div className="space-y-4">
        <p className="text-text-muted">{t('intro')}</p>
        <p role="alert" aria-live="polite" className="min-h-6 text-danger">
          {start.status === 'error'
            ? t(start.code === 'rateLimited' ? 'rateLimited' : 'invalid')
            : ''}
        </p>
        <button
          type="button"
          disabled={starting}
          onClick={() => {
            startTransition(async () => {
              setStart(await startEnrolAction());
            });
          }}
          className={buttonClass}
        >
          {t('start')}
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const { code = '' } = formValues(event.currentTarget, ['code']);
        startConfirm(async () => {
          setConfirm(await confirmEnrolAction({ code }));
        });
      }}
      className="space-y-4"
    >
      <div>
        <p className="font-medium">{t('secretLabel')}</p>
        <p className="break-all font-mono">{start.secret}</p>
      </div>
      <div>
        <p className="font-medium">{t('uriLabel')}</p>
        <p className="break-all font-mono text-sm text-text-muted">{start.uri}</p>
      </div>
      <label className="block">
        {t('codeLabel')}
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          className={fieldClass}
        />
      </label>
      <p role="alert" aria-live="polite" className="min-h-6 text-danger">
        {confirm.status === 'error'
          ? t(confirm.code === 'rateLimited' ? 'rateLimited' : 'invalid')
          : ''}
      </p>
      <button type="submit" disabled={confirming} className={buttonClass}>
        {t('confirm')}
      </button>
    </form>
  );
}
