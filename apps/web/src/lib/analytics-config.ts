import {
  analyticsConfig,
  invalidAnalyticsIds,
  type AnalyticsConfig,
} from '@store/shared/analytics';

import { runtimeEnv } from './runtime-env';

let warned = false;

/**
 * The identifiers the browser may know, or null (not production, or none set). Read from the
 * runtime environment (ADR-10), never from `NEXT_PUBLIC_*`: one image serves staging and
 * production, and staging must never carry a tracker. A malformed identifier is dropped (the shop
 * keeps running) and its NAME is logged once, so the typo is found without reading the value.
 */
export async function getAnalyticsConfig(): Promise<AnalyticsConfig | null> {
  const env = await runtimeEnv();
  if (!warned && env.APP_ENV === 'production') {
    const names = invalidAnalyticsIds(env);
    if (names.length > 0) {
      warned = true;
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', scope: 'analytics', reason: 'malformed identifier ignored', names })}\n`,
      );
    }
  }
  return analyticsConfig(env.APP_ENV, env);
}
