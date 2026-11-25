import type { AuthConfig } from '@store/core/auth';

import { runtimeEnv } from '../runtime-env';

/** Auth settings from the validated environment (a missing `AUTH_SECRET` makes auth refuse, never open). */
export async function authConfig(): Promise<AuthConfig> {
  const env = await runtimeEnv();
  return { secret: env.AUTH_SECRET, issuer: 'Silk admin' };
}

/** Cookies are `Secure` everywhere except a local http server. */
export async function cookiesAreSecure(): Promise<boolean> {
  return (await runtimeEnv()).APP_ENV !== 'local';
}

/** The host the site is served from; the `Origin` of an action must match it. */
export async function expectedHost(requestHost: string | null): Promise<string | null> {
  const env = await runtimeEnv();
  const configured = env.SITE_URL ?? env.NEXT_PUBLIC_SITE_URL;
  if (configured !== undefined) return new URL(configured).host;
  // Without a configured site (local development) the Host header is the only source.
  return env.APP_ENV === 'local' ? requestHost : null;
}
