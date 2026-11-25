'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { signOutOtherSessionsAction } from '@/actions/admin-account';

export function SignOutOthers() {
  const t = useTranslations('admin.dashboard');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-6">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const result = await signOutOtherSessionsAction();
            setMessage(
              result.ok ? t('signedOutOthers', { count: result.ended }) : t('signOutFailed'),
            );
          });
        }}
        className="min-h-11 min-w-11 rounded-md border border-border px-3"
      >
        {t('signOutOthers')}
      </button>
      <p role="status" aria-live="polite" className="mt-2 min-h-6 text-text-muted">
        {message}
      </p>
    </div>
  );
}
