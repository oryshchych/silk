import { type AdminRole, can } from '@store/core/auth-permissions';
import {
  runDashboard,
  runReport,
  shopToday as readShopToday,
  type ParsedReport,
  type Period,
} from '@store/core/reports';
import type { DashboardDto, ReportResultDto } from '@store/shared/dto/reports';

import { getDb } from '@/lib/db';
import { createKeyedComputation } from '@/lib/keyed-computation';

/**
 * Every report, for the screen AND the export, goes through here: a read-only transaction with its
 * own statement timeout (a slow report cannot hold a connection longer), a result shared for 60 s
 * per (report, parameters, cost visibility) and at most three computations at once. The cache key
 * carries whether the caller may see the cost: a cost-bearing result is never handed to a role
 * without the permission, and the role check runs before the cache is consulted.
 */
interface Context {
  request: ParsedReport;
  role: AdminRole;
}

const computation = createKeyedComputation<ReportResultDto, Context>(
  async ({ request, role }) => {
    return await runReport(await getDb(), request, role);
  },
  { ttlMs: 60_000, minRefreshMs: 5_000, maxKeys: 200, maxRunning: 3 },
);

export async function loadReport(
  request: ParsedReport,
  role: AdminRole,
  refresh = false,
): Promise<ReportResultDto> {
  // Only the two capabilities that change the result are part of the key, never the role name.
  const costRole: AdminRole = can(role, 'catalog.cost.view') ? 'owner' : 'manager';
  const { value } = await computation.get(
    JSON.stringify({ request, cost: costRole === 'owner' }),
    refresh,
    { request, role: costRole },
  );
  return value;
}

/** Today in the shop zone, decided by the database (the default period of a report). */
export async function shopToday(): Promise<string> {
  return await readShopToday(await getDb());
}

interface DashboardContext {
  period: Period;
  includeCost: boolean;
}

const dashboardComputation = createKeyedComputation<DashboardDto, DashboardContext>(
  async ({ period, includeCost }) => {
    return await runDashboard(await getDb(), period, { includeCost });
  },
  { ttlMs: 60_000, minRefreshMs: 5_000, maxKeys: 50, maxRunning: 3 },
);

/** The dashboard: shared for 60 s per (period, cost visibility), the margin KPI only for the cost role. */
export async function loadDashboard(
  period: Period,
  role: AdminRole,
  refresh = false,
): Promise<DashboardDto> {
  const includeCost = can(role, 'catalog.cost.view');
  const { value } = await dashboardComputation.get(
    JSON.stringify({ period, includeCost }),
    refresh,
    { period, includeCost },
  );
  return value;
}
