import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { AuthCard } from '@/components/admin/auth-card';
import { LoginForm } from '@/components/admin/login-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { currentSession } from '@/lib/admin/session';

export default async function LoginPage() {
  const resolved = await currentSession();
  if (resolved?.kind === 'full') redirect('/admin');
  if (resolved?.kind === 'pending')
    redirect(resolved.next === 'totp' ? '/admin/verify' : '/admin/enroll');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.login' });
  return (
    <AuthCard title={t('title')}>
      <LoginForm />
    </AuthCard>
  );
}
