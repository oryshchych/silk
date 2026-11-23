import type { env } from '@store/shared/env';

/**
 * The validated environment, loaded on first use. `next build` has no variables and must not
 * need them (no page reads them while building), so no module may import `@store/shared/env`
 * at the top level (a type-only import above is erased).
 */
export async function runtimeEnv(): Promise<typeof env> {
  return (await import('@store/shared/env')).env;
}
