import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { AuthCard } from '@/components/admin/auth-card';
import { EnrolForm } from '@/components/admin/enroll-form';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { currentSession, requirePendingStep } from '@/lib/admin/session';

export default async function EnrolPage() {
  // A FULL session may stay: the confirm action has just replaced the pending one and the form is
  // still showing the recovery codes. Anything else must be at the enrolment step.
  const resolved = await currentSession();
  const signedIn = resolved?.kind === 'full';
  if (!signedIn) await requirePendingStep('enroll');
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.enroll' });
  return (
    <AuthCard title={t('title')}>
      <EnrolForm signedIn={signedIn} />
    </AuthCard>
  );
}
