import { analyticsConfig, type AnalyticsConfig } from '@store/shared/analytics';

import { runtimeEnv } from './runtime-env';

/**
 * The identifiers the browser may know, or null (not production, or none set). Read from the
 * runtime environment (ADR-10), never from `NEXT_PUBLIC_*`: one image serves staging and
 * production, and staging must never carry a tracker.
 */
export async function getAnalyticsConfig(): Promise<AnalyticsConfig | null> {
  const env = await runtimeEnv();
  return analyticsConfig(env.APP_ENV, env);
}
