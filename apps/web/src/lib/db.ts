import { createDb, type DbHandle } from '@store/db/client';

declare global {
  // One pool per process, kept across dev hot reloads.
  var silkDbHandle: DbHandle | undefined;
}

/**
 * Pool of the app role (`DATABASE_URL`, DML only). Created on first use and
 * the environment is imported lazily: `next build` has no variables and must
 * not need a database (no catalog page is prerendered).
 */
export async function getDb(): Promise<DbHandle['db']> {
  if (globalThis.silkDbHandle === undefined) {
    const { env } = await import('@store/shared/env');
    globalThis.silkDbHandle = createDb(env.DATABASE_URL, { max: 5 });
  }
  return globalThis.silkDbHandle.db;
}
