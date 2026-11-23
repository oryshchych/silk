/**
 * Seed-генератор моків (фаза 0, питання №5): РЕАЛЬНІ рядки в БД, не
 * фікстури, тому все редагується звичайною адмінкою.
 *
 * Запобіжники:
 *  - production — відмова ДО з'єднання з БД (`assertSeedAllowed`);
 *  - непорожній каталог — відмова: seed не дописує поверх живих даних;
 *  - усе в одній транзакції: падіння на будь-якому кроці не лишає
 *    половини магазину.
 *
 * Сертифікатів немає навмисно: на 2-й групі єдиного податку вони
 * заборонені (GIFT_CARDS.md §0).
 */
import { count, sql } from 'drizzle-orm';

import type { AppEnv } from '@store/shared/env-schema';

import {
  customers,
  orders,
  productVariants,
  products,
  promoCodes,
  reviews,
} from '../src/schema.ts';
import type { Tx } from '../src/types.ts';
import { seedCatalog } from './catalog.ts';
import { seedCustomers } from './customers.ts';
import { seedNpDirectory } from './np-directory.ts';
import { seedOrders } from './orders.ts';
import { seedPromoCodes } from './promo.ts';
import { createRng } from './random.ts';
import { seedReviews } from './reviews.ts';

/** Фіксований seed PRNG: однакові дані на кожній машині. */
const RNG_SEED = 20261026;

export interface SeedSummary {
  products: number;
  variants: number;
  orders: number;
  promoCodes: number;
  reviews: number;
}

export function assertSeedAllowed(appEnv: AppEnv): void {
  if (appEnv === 'production') {
    throw new Error('seed is forbidden in production (APP_ENV=production)');
  }
}

/**
 * Hosts a seed may write to: loopback and the compose service name of the
 * deployed stacks. APP_ENV alone is not a safe key: `APP_ENV=staging` with a
 * production DATABASE_URL would pass `assertSeedAllowed`, and production is
 * empty before the first catalog import, so the non-empty check would not
 * stop it either.
 */
const SEED_DB_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres']);

export function assertSeedTargetAllowed(databaseUrl: string): void {
  const { hostname } = new URL(databaseUrl);
  if (!SEED_DB_HOSTS.has(hostname)) {
    throw new Error(
      `seed refuses database host "${hostname}": allowed hosts are ${[...SEED_DB_HOSTS].join(', ')}`,
    );
  }
}

export async function seed(tx: Tx): Promise<SeedSummary> {
  const [existing] = await tx.select({ n: count() }).from(products);
  if (existing !== undefined && existing.n > 0) {
    throw new Error(
      `catalog is not empty (${String(existing.n)} products): seed needs an empty database`,
    );
  }

  for (const [name, table] of [
    ['orders', orders],
    ['customers', customers],
  ] as const) {
    const [row] = await tx.select({ n: count() }).from(table);
    if (row !== undefined && row.n > 0) {
      throw new Error(`${name} is not empty (${String(row.n)} rows): seed needs an empty database`);
    }
  }

  const rng = createRng(RNG_SEED);
  const catalog = await seedCatalog(tx, rng);
  await seedNpDirectory(tx);
  const people = await seedCustomers(tx);
  const bras = catalog.categoryIds['bras'];
  if (bras === undefined) throw new Error('немає категорії bras');
  const promos = await seedPromoCodes(tx, bras);
  const purchases = await seedOrders(tx, rng, catalog.variants, people, promos);
  await seedReviews(tx, rng, purchases, people, catalog.productIds);

  // «Останні одиниці» — з фактичного доступного залишку, після резервів.
  await tx.execute(sql`
    UPDATE products SET badge = 'last_units'
     WHERE badge = 'none' AND is_active
       AND id IN (SELECT product_id FROM product_variants
                   GROUP BY product_id
                  HAVING sum(stock_quantity - reserved_quantity) BETWEEN 1 AND 3)`);

  const countOf = async (
    table:
      typeof products | typeof productVariants | typeof orders | typeof promoCodes | typeof reviews,
  ): Promise<number> => {
    const [row] = await tx.select({ n: count() }).from(table);
    return row?.n ?? 0;
  };
  return {
    products: await countOf(products),
    variants: await countOf(productVariants),
    orders: await countOf(orders),
    promoCodes: await countOf(promoCodes),
    reviews: await countOf(reviews),
  };
}
