/**
 * CLI: `pnpm db:seed-synthetic [orders]` writes the synthetic order history (default 50 000) into a
 * LOCAL, EMPTY database for report performance checks. Same guards as `pnpm db:seed`: refused in
 * production, refused on a non-local host, refused when orders already exist.
 */
import { env } from '@store/shared/env';

import { createDb } from '../src/client.ts';
import { assertSeedAllowed, assertSeedTargetAllowed } from './seed.ts';
import { SYNTHETIC_DEFAULT_ORDERS, seedSynthetic } from './synthetic.ts';

assertSeedAllowed(env.APP_ENV);
assertSeedTargetAllowed(env.DATABASE_URL);

const arg = process.argv[2];
if (arg !== undefined && !/^[0-9]{1,7}$/.test(arg)) {
  process.stderr.write('usage: pnpm db:seed-synthetic [number of orders]\n');
  process.exit(2);
}
const orders = arg === undefined ? SYNTHETIC_DEFAULT_ORDERS : Number(arg);

const { db, close } = createDb(env.DATABASE_URL, { max: 1, statementTimeoutMs: 600_000 });
try {
  const summary = await db.transaction(async (tx) => await seedSynthetic(tx, { orders }));
  process.stdout.write(
    `synthetic (${env.APP_ENV}): ${String(summary.orders)} orders, ${String(summary.lines)} lines, ` +
      `${String(summary.attempts)} payments, ${String(summary.refunds)} refunds, ${String(summary.returns)} returns\n`,
  );
} finally {
  await close();
}
