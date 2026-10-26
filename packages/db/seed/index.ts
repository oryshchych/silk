/**
 * CLI: `pnpm db:seed`. Читає середовище через @store/shared/env (ADR-10):
 * APP_ENV і DATABASE_URL (роль store_app — seed робить лише DML).
 */
import { env } from '@store/shared/env';

import { createDb } from '../src/client.ts';
import { assertSeedAllowed, seed } from './seed.ts';

assertSeedAllowed(env.APP_ENV);

const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
try {
  const summary = await db.transaction(async (tx) => await seed(tx));
  process.stdout.write(
    `seed (${env.APP_ENV}): ${String(summary.products)} товарів, ${String(summary.variants)} варіантів, ` +
      `${String(summary.orders)} замовлень, ${String(summary.promoCodes)} промокодів, ` +
      `${String(summary.reviews)} відгуків\n`,
  );
} finally {
  await close();
}
