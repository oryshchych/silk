'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { customerLogoutAction } from '@/actions/account-auth';

export function SignOutButton({ locale }: { locale: 'uk' | 'en' }) {
  const t = useTranslations('account');
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        start(async () => {
          await customerLogoutAction({ locale });
        });
      }}
      className="min-h-11 rounded-full border border-border px-6 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
    >
      {t('signOut')}
    </button>
  );
}
