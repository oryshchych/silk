import { can } from '@store/core/auth-permissions';
import { parsePeriod, shiftDay } from '@store/core/reports';
import type { DashboardDto } from '@store/shared/dto/reports';
import { getMessages, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { DashboardView } from '@/components/admin/dashboard-view';
import { SignOutOthers } from '@/components/admin/sign-out-others';
import { makeTranslator } from '@/lib/admin/message-lookup';
import { LOCALE_COOKIE, parseAdminLocale } from '@/lib/admin/preferences';
import { loadDashboard, shopToday } from '@/lib/admin/reports-runner';
import { requireFullSession } from '@/lib/admin/session';
import { BusyError } from '@/lib/keyed-computation';
import { createRateLimiter } from '@/lib/rate-limit';

// A page view is one or two requests (the second a Flight fetch); the computation itself is shared and
// capped, so this limit is for floods, not for people.
const limiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

/**
 * The overview. A role that may read reports sees the key figures (last 30 shop days against the
 * previous 30 and the same dates last year) and the alerts; the margin KPI is in the list only for a
 * role with the cost permission. A role without `reports.view` (content) sees the plain welcome.
 */
export default async function AdminDashboardPage() {
  const session = await requireFullSession();
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.dashboard' });
  let dashboard: DashboardDto | null = null;
  if (can(session.role, 'reports.view') && limiter.check(session.userId).allowed) {
    const today = await shopToday();
    try {
      dashboard = await loadDashboard(
        parsePeriod({ from: shiftDay(today, -29), to: today, granularity: 'day' }),
        session.role,
      );
    } catch (error) {
      if (!(error instanceof BusyError)) throw error;
    }
  }
  const reports = makeTranslator(await getMessages({ locale }), 'admin.dashboardReports');
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {dashboard === null ? (
        <p className="mt-2 text-text-muted">{t('welcome')}</p>
      ) : (
        <div className="mt-4">
          <DashboardView
            dashboard={dashboard}
            t={reports}
            locale={locale}
            can={{ orders: can(session.role, 'orders.view'), reports: true }}
          />
        </div>
      )}
      <SignOutOthers />
    </>
  );
}
