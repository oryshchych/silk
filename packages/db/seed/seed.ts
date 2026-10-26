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

import { orders, productVariants, products, promoCodes, reviews } from '../src/schema.ts';
import type { Tx } from '../src/types.ts';
import { seedCatalog } from './catalog.ts';
import { seedCustomers } from './customers.ts';
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
    throw new Error('seed заборонений у production (APP_ENV=production)');
  }
}

export async function seed(tx: Tx): Promise<SeedSummary> {
  const [existing] = await tx.select({ n: count() }).from(products);
  if (existing !== undefined && existing.n > 0) {
    throw new Error(
      `каталог не порожній (${String(existing.n)} товарів) — seed працює лише на порожній БД`,
    );
  }

  const rng = createRng(RNG_SEED);
  const catalog = await seedCatalog(tx, rng);
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
