import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { AuthCard } from '@/components/admin/auth-card';
import { VerifyForm } from '@/components/admin/verify-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { requirePendingStep } from '@/lib/admin/session';

export default async function VerifyPage() {
  await requirePendingStep('totp');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.verify' });
  return (
    <AuthCard title={t('title')}>
      <VerifyForm />
      <a href="/admin/login" className="mt-4 inline-flex min-h-11 items-center underline">
        {t('backToLogin')}
      </a>
    </AuthCard>
  );
}
