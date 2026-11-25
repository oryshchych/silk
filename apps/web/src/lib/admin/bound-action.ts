import { headers } from 'next/headers';

import { getDb } from '../db';
import { createRateLimiter } from '../rate-limit';
import { currentClient } from '../request-limits';
import { runtimeEnv } from '../runtime-env';
import { createAdminAction } from './action';
import { expectedHost } from './config';
import { isSameOrigin } from './origin';
import { currentSession } from './session';

/** Mutations per signed-in user: a person edits a few things a minute, a runaway script hundreds. */
const mutationLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

/** The CSRF check for the current request: an `Origin` whose host is the site's host. */
export async function requestOriginOk(): Promise<boolean> {
  const list = await headers();
  const host = await expectedHost(list.get('x-forwarded-host') ?? list.get('host'));
  return isSameOrigin(list.get('origin'), host);
}

/** `adminAction` wired to the request: cookies, headers, the database pool. Use this in server actions. */
export const adminAction = createAdminAction({
  originOk: requestOriginOk,
  session: currentSession,
  transaction: async (fn) => await (await getDb()).transaction(fn),
  client: async () => {
    await runtimeEnv();
    return await currentClient();
  },
  limiter: mutationLimiter,
});
